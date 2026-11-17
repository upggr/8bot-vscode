import { compactLimit, compactionCut, DEFAULT_OUTPUT_TOKENS, estimateTokens, flattenForSummary, KEEP_TOKENS_AFTER_COMPACT, keepTokensFor, looksLikeOverflow, SUMMARY_PREFIX, trimForRequest } from './context';
import { StallError } from './gateway';
import { decide, PermissionMode, rememberKey, ToolKind } from './permissions';
import { byteSize, COMPACT_REQUEST_BYTES } from './requestSize';
import { findTool, Tool, TOOLS, ToolContext } from './tools';
import { ChatMessage, ChatStreamer, ToolCall, Usage } from './types';

export type PermissionAnswer = 'allow' | 'always' | 'deny';

export interface PermissionRequest {
	callId: string;
	tool: string;
	kind: ToolKind;
	summary: string;
	args: Record<string, unknown>;
	preview?: { path: string; before: string; after: string };
}

/**
 * What the run is doing right now, so the UI can always say why it is quiet:
 * waiting for the model's first token, receiving a tool call, or running tools.
 */
export type AgentPhase = 'waiting' | 'writingTool' | 'tools';

export type AgentEvent =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'phase'; phase: AgentPhase; detail?: string }
	| { type: 'toolStart'; callId: string; tool: string; summary: string; args: Record<string, unknown> }
	/** Live output from a running step: command output, or a sub-agent's current activity. */
	| { type: 'toolProgress'; callId: string; text: string }
	| { type: 'toolEnd'; callId: string; ok: boolean; output: string }
	| { type: 'usage'; usage: Usage }
	| { type: 'notice'; message: string }
	| { type: 'compacted'; removed: ChatMessage[] };

export interface AgentOptions {
	client: ChatStreamer;
	model: string;
	systemPrompt: string;
	/** Conversation without the system prompt. Updated in place. */
	messages: ChatMessage[];
	root: string;
	commandTimeoutSeconds: number;
	maxTurns: number;
	contextWindow?: number;
	maxTokens?: number;
	/** The most output the model allows, used when a retry needs more room. */
	modelMaxOutput?: number;
	reasoningEffort?: string;
	supportsTools?: boolean;
	/** Surface the gateway's content-guard flags in the chat. Off by default since it is routine and noisy. */
	showGuardNotices?: boolean;
	getMode(): PermissionMode;
	requestPermission(request: PermissionRequest): Promise<PermissionAnswer>;
	onEvent(event: AgentEvent): void;
	/** Private per-project memory notes. */
	memoryFile?: string;
	/** Answers remembered with "always". Pass the same set across a conversation. */
	remembered?: Set<string>;
	/** Upper bound for how deep sub-agents may spawn their own sub-agents (0 disables spawning). */
	spawnDepth?: number;
	/** Model turns each sub-agent gets. Defaults to SUBAGENT_MAX_TURNS. */
	subagentMaxTurns?: number;
	/** Reasoning effort for sub-agents. Undefined inherits the parent's; an empty string uses the model default. */
	subagentReasoningEffort?: string;
	signal?: AbortSignal;
}

/** Tool the model can call to hand a focused subtask to a fresh sub-agent. */
const SPAWN_TOOL = 'spawn_agent';
const SPAWN_SCHEMA = {
	type: 'function',
	function: {
		name: SPAWN_TOOL,
		description: 'Spawn a sub-agent to handle a focused, self-contained subtask with its own fresh context. Use it for parallelizable or exploratory work (research a question, find usages, draft an isolated change) so the main conversation stays focused. Sub-agents spawned in the same turn run at the same time, so start independent ones together and do not let two of them edit the same file. Each has a limited number of turns: keep its task small enough to finish, and ask it to write findings to a file as it goes. The sub-agent can use tools and returns a concise result. Give it complete instructions; it does not see this conversation.',
		parameters: {
			type: 'object',
			properties: {
				task: { type: 'string', description: 'Complete, self-contained instructions for the sub-agent.' },
				name: { type: 'string', description: 'A short label for the subtask, e.g. "find usages".' },
			},
			required: ['task'],
		},
	},
} as const;

/** A stalled request is retried this many times before the error reaches the user. */
const STALL_RETRIES = 1;

const COMPACT_PROMPT = 'Summarize this conversation so work can continue from the summary alone. Include the user\'s goals and exact requests, decisions made, files changed, errors and how they were solved, the current state, and the next step. Output only the summary.';
const MIN_TURNS_BETWEEN_COMPACTIONS = 3;
/** Some models occasionally spend a whole turn on hidden thinking and return nothing. */
const MAX_EMPTY_RETRIES = 2;
const CONTINUE_PROMPT = 'Continue with the task. Use a tool or give your response now.';

/** Models where marking the latest message for caching has been verified to work. */
const CONVERSATION_CACHE_MODELS = /claude/i;

export function toolSchemas(spawnDepth = 0) {
	return spawnDepth > 0 ? [...TOOLS.map(t => t.schema), SPAWN_SCHEMA] : TOOLS.map(t => t.schema);
}

/**
 * Replaces older messages with a model-written summary and keeps recent work
 * intact. Returns the messages it removed, or an empty list if nothing was old enough.
 */
export async function compact(options: Pick<AgentOptions, 'client' | 'model' | 'messages' | 'signal' | 'maxTokens'>, keepTokens = KEEP_TOKENS_AFTER_COMPACT): Promise<ChatMessage[]> {
	const { messages } = options;
	const cut = compactionCut(messages, keepTokens);
	if (cut === 0) { return []; }
	let summary = '';
	const request: ChatMessage[] = [{ role: 'user', content: `${COMPACT_PROMPT}\n\n<conversation>\n${flattenForSummary(messages.slice(0, cut))}\n</conversation>` }];
	for await (const event of options.client.streamChat({ model: options.model, messages: request, maxTokens: options.maxTokens }, options.signal)) {
		if (event.type === 'text') { summary += event.text; }
	}
	if (!summary.trim()) { throw new Error('The model returned an empty summary.'); }
	return messages.splice(0, cut, { role: 'user', content: `${SUMMARY_PREFIX}\n\n${summary}` });
}

/** Marks stable text for the prompt cache, which greatly reduces the cost of repeated context. */
export function withCacheMarkers(system: string, messages: ChatMessage[], model: string): ChatMessage[] {
	const marker = { type: 'ephemeral' as const };
	const out: ChatMessage[] = [{ role: 'system', content: [{ type: 'text', text: system, cache_control: marker }] }, ...messages];
	const last = out.at(-1);
	if (CONVERSATION_CACHE_MODELS.test(model) && out.length > 1 && last && typeof last.content === 'string' && last.content) {
		out[out.length - 1] = { ...last, content: [{ type: 'text', text: last.content, cache_control: marker }] };
	}
	return out;
}

/** How a run ended: the model gave its answer, it was stopped, it used up its turns, or it kept replying with nothing. */
export type RunOutcome = 'done' | 'aborted' | 'turnLimit' | 'empty';

/** Runs model turns and tools until the model finishes, is stopped, or reaches the turn limit. */
export async function runAgent(options: AgentOptions): Promise<RunOutcome> {
	const { client, messages, signal, onEvent } = options;
	const remembered = options.remembered ?? new Set<string>();
	const tools = options.supportsTools === false ? undefined : toolSchemas(options.spawnDepth ?? 0);
	const overhead = Math.ceil((options.systemPrompt.length + JSON.stringify(tools ?? []).length) / 4);
	let contextWindow = options.contextWindow;
	let calibration = 1;
	let lastCompaction = -MIN_TURNS_BETWEEN_COMPACTIONS;
	let recovered = false;
	let emptyReplies = 0;
	let maxTokens = options.maxTokens;
	let stallRetries = 0;
	// The gateway guard can flag every request; report it once, then just count repeats.
	let guardNotices = 0;

	const summarize = async (turn: number, message: string, keepTokens = keepTokensFor(contextWindow)): Promise<boolean> => {
		onEvent({ type: 'notice', message });
		onEvent({ type: 'phase', phase: 'waiting', detail: 'summarizing older messages' });
		const removed = await compact(options, keepTokens);
		if (removed.length === 0) { return false; }
		lastCompaction = turn;
		onEvent({ type: 'compacted', removed });
		return true;
	};

	for (let turn = 0; turn < options.maxTurns; turn++) {
		let outgoing = trimForRequest(messages, contextWindow, calibration);
		let estimate = estimateTokens(outgoing) + overhead;
		if (contextWindow && estimate * calibration > compactLimit(contextWindow)
			&& turn - lastCompaction >= MIN_TURNS_BETWEEN_COMPACTIONS && compactionCut(messages, keepTokensFor(contextWindow)) > 0) {
			await summarize(turn, 'Context is nearly full, summarizing older messages.');
			outgoing = trimForRequest(messages, contextWindow, calibration);
			estimate = estimateTokens(outgoing) + overhead;
		}
		// Models with huge context windows reach the gateway's size limit long before their token limit.
		if (byteSize(outgoing) > COMPACT_REQUEST_BYTES && turn - lastCompaction >= MIN_TURNS_BETWEEN_COMPACTIONS && compactionCut(messages, KEEP_TOKENS_AFTER_COMPACT) > 0) {
			lastCompaction = turn;
			try {
				await summarize(turn, 'This chat is nearing the gateway size limit, summarizing older messages.', KEEP_TOKENS_AFTER_COMPACT);
			} catch (error) {
				if (signal?.aborted) { return 'aborted'; }
				// The request can still go out, because the client leaves old content out to fit.
				onEvent({ type: 'notice', message: `Could not summarize older messages, so some are left out of this request. ${(error as Error).message}` });
			}
			outgoing = trimForRequest(messages, contextWindow, calibration);
			estimate = estimateTokens(outgoing) + overhead;
		}

		let text = '';
		const calls: ToolCall[] = [];
		let finish = '';
		let toolCharsShown = -1;

		onEvent({ type: 'phase', phase: 'waiting' });
		try {
			const stream = client.streamChat({
				model: options.model,
				// A second empty reply gets an explicit nudge, which is not saved to the chat.
				messages: withCacheMarkers(options.systemPrompt, emptyReplies >= MAX_EMPTY_RETRIES ? [...outgoing, { role: 'user', content: CONTINUE_PROMPT }] : outgoing, options.model),
				tools,
				maxTokens,
				reasoningEffort: options.reasoningEffort,
				// Gateway retries otherwise wait silently for up to half a minute.
				onRetry: detail => onEvent({ type: 'phase', phase: 'waiting', detail }),
			}, signal);
			for await (const event of stream) {
				if (signal?.aborted) { break; }
				if (event.type === 'text') { text += event.text; onEvent(event); }
				else if (event.type === 'reasoning') { onEvent(event); }
				else if (event.type === 'tool_call') { calls.push(event.call); }
				else if (event.type === 'tool_progress') {
					// Throttled to about one update per 500 characters, so a big edit does not flood the UI.
					if (toolCharsShown < 0 || event.chars - toolCharsShown >= 500) {
						toolCharsShown = event.chars;
						onEvent({ type: 'phase', phase: 'writingTool', detail: `${event.name} · ${Math.ceil(event.chars / 4).toLocaleString('en-US')} tokens` });
					}
				}
				else if (event.type === 'usage') {
					if (event.usage.promptTokens > 0) { calibration = Math.min(Math.max(event.usage.promptTokens / estimate, 0.5), 4); }
					onEvent({ type: 'usage', usage: event.usage });
				}
				else if (event.type === 'failover') {
					contextWindow = event.contextWindow;
					onEvent({ type: 'notice', message: `Automatic routing was rejected by the gateway, so this request continues on ${event.name}.` });
				}
				else if (event.type === 'guard') {
					guardNotices++;
					// Routine PII-masking info; log it and only surface in chat when explicitly enabled.
					console.debug(`8bot: gateway guard flagged this request (result: ${event.result}, risk: ${event.risk}, recommendation: ${event.recommendation}).`);
					if (options.showGuardNotices && guardNotices === 1) {
						onEvent({ type: 'notice', message: `The gateway guard flagged this request (result: ${event.result}, risk: ${event.risk}, recommendation: ${event.recommendation}).` });
					}
				}
				else { finish = event.reason; }
			}
		} catch (error) {
			if (text) { messages.push({ role: 'assistant', content: text }); }
			if (signal?.aborted) { return 'aborted'; }
			// A stalled connection usually works on a fresh request, so retry once before giving up.
			// Not after text arrived, because the user has already seen part of that answer.
			if (error instanceof StallError && !text && stallRetries < STALL_RETRIES) {
				stallRetries++;
				onEvent({ type: 'notice', message: `The gateway sent nothing for ${error.seconds}s, so the request was sent again.` });
				turn--;
				continue;
			}
			if (!text && !recovered && looksLikeOverflow(error, estimate * calibration, contextWindow)) {
				recovered = true;
				if (await summarize(turn, 'The request was too large, summarizing older messages and retrying.')) {
					turn--;
					continue;
				}
			}
			throw error;
		}

		if (signal?.aborted) {
			if (text) { messages.push({ role: 'assistant', content: text }); }
			return 'aborted';
		}
		if (!text && calls.length === 0) {
			if (emptyReplies < MAX_EMPTY_RETRIES) {
				emptyReplies++;
				if (finish === 'length') {
					// An empty-but-truncated reply often means the gateway's small default output
					// limit cut off a thinking model before it wrote any text, including on "auto".
					const grown = maxTokens ? maxTokens * 2 : DEFAULT_OUTPUT_TOKENS;
					maxTokens = options.modelMaxOutput ? Math.min(grown, options.modelMaxOutput) : grown;
				}
				if (emptyReplies === 1) { onEvent({ type: 'notice', message: 'The model returned nothing, trying again.' }); }
				turn--;
				continue;
			}
			onEvent({ type: 'notice', message: `The model returned an empty response ${emptyReplies + 1} times (finish reason: ${finish || 'none'}). Send "continue" or try another model.` });
			return 'empty';
		}
		emptyReplies = 0;
		stallRetries = 0;
		messages.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text });

		if (calls.length === 0) {
			if (finish === 'length') { onEvent({ type: 'notice', message: 'The response stopped at the output token limit.' }); }
			if (options.showGuardNotices && guardNotices > 1) { onEvent({ type: 'notice', message: `(The gateway guard flagged ${guardNotices} requests in this run.)` }); }
			return 'done';
		}

		onEvent({ type: 'phase', phase: 'tools' });
		const outputs = await runCalls(calls, options, remembered);
		calls.forEach((call, i) => messages.push({ role: 'tool', tool_call_id: call.id, content: outputs[i] }));
		if (signal?.aborted) { return 'aborted'; }
	}
	onEvent({ type: 'notice', message: `Stopped after ${options.maxTurns} turns. Send "continue" to keep going.` });
	return 'turnLimit';
}

const MAX_PARALLEL_CALLS = 6;

/** Tools with no side effects, so several can run at the same time. Sub-agents check their own tools. */
const CONCURRENT_TOOLS = new Set(['read_file', 'list_files', 'search_text', SPAWN_TOOL]);

/**
 * Runs one turn's tool calls and returns their outputs in call order. Reads and sub-agents run
 * at the same time; edits, commands and memory changes wait for the reads before them and run
 * one at a time, so the model still sees the effects of its calls in the order it made them.
 */
async function runCalls(calls: ToolCall[], options: AgentOptions, remembered: Set<string>): Promise<string[]> {
	const outputs: string[] = new Array(calls.length);
	const ask = serialize();
	const run = async (i: number) => {
		outputs[i] = options.signal?.aborted ? 'Stopped by the user.' : await executeCall(calls[i], { ...options, requestPermission: ask(options.requestPermission) }, remembered);
	};
	let batch: number[] = [];
	const flush = async () => {
		for (let start = 0; start < batch.length; start += MAX_PARALLEL_CALLS) {
			await Promise.all(batch.slice(start, start + MAX_PARALLEL_CALLS).map(run));
		}
		batch = [];
	};
	for (let i = 0; i < calls.length; i++) {
		if (CONCURRENT_TOOLS.has(calls[i].function.name)) {
			batch.push(i);
		} else {
			await flush();
			await run(i);
		}
	}
	await flush();
	return outputs;
}

/** Wraps permission prompts so parallel calls ask one at a time instead of stacking dialogs. */
function serialize() {
	let queue: Promise<unknown> = Promise.resolve();
	return (ask: AgentOptions['requestPermission']): AgentOptions['requestPermission'] => request => {
		const answer = queue.then(() => ask(request));
		queue = answer.catch(() => undefined);
		return answer;
	};
}

async function executeCall(call: ToolCall, options: AgentOptions, remembered: Set<string>): Promise<string> {
	const { onEvent } = options;
	const name = call.function.name;
	let args: Record<string, unknown>;
	try {
		args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) as Record<string, unknown> : {};
	} catch {
		return report(onEvent, call.id, name, {}, name, false, `The arguments for ${name} were not valid JSON. The output may have been cut off. Try again with a smaller change.`);
	}
	if (name === SPAWN_TOOL) {
		return runSubagent(call.id, args, options);
	}
	const tool = findTool(name);
	if (!tool) {
		return report(onEvent, call.id, name, args, name, false, `Unknown tool: ${name}`);
	}
	const summary = tool.summary(args);
	const mode = options.getMode();
	const context: ToolContext = {
		root: options.root,
		allowOutsideWorkspace: mode === 'bypassPermissions',
		commandTimeoutSeconds: options.commandTimeoutSeconds,
		signal: options.signal,
		memoryFile: options.memoryFile,
		onOutput: text => onEvent({ type: 'toolProgress', callId: call.id, text }),
	};
	onEvent({ type: 'toolStart', callId: call.id, tool: name, summary, args });

	const kind = tool.kind(args, context);
	const decision = decide(mode, kind);
	if (decision === 'deny') {
		return finish(onEvent, call.id, false, `${summary} is blocked in plan mode. Describe the change instead of making it.`);
	}
	const key = rememberKey(name, args);
	if (decision === 'ask' && !remembered.has(key)) {
		const answer = await options.requestPermission({ callId: call.id, tool: name, kind, summary, args, preview: await previewOf(tool, args, context) });
		if (answer === 'deny') {
			return finish(onEvent, call.id, false, 'The user denied this action. Do not retry it. Ask what they want instead.');
		}
		if (answer === 'always') { remembered.add(key); }
	}
	try {
		return finish(onEvent, call.id, true, await tool.run(args, context));
	} catch (error) {
		return finish(onEvent, call.id, false, `Error: ${(error as Error).message}`);
	}
}

export const SUBAGENT_MAX_TURNS = 40;
const SUBAGENT_CHARS = 12_000;
/** How much of a cut-off sub-agent's own transcript is replayed to write its partial report. */
const SUBAGENT_RESCUE_CHARS = 40_000;
const SUBAGENT_RESCUE_PROMPT = 'You ran out of turns before finishing. Using only the work below, reply now with what you found or did so far, which file paths are involved, and what is still left to do. Do not call tools.';

/**
 * Resolves the sub-agent reasoning setting for a model: "inherit" keeps the parent's effort,
 * an effort the model lacks falls back to the model default, and empty means the model default.
 */
export function subagentEffort(setting: string | undefined, supported: string[] = []): string | undefined {
	if (setting === 'inherit') { return undefined; }
	return setting && supported.includes(setting) ? setting : '';
}

/** Runs a focused sub-agent with its own fresh conversation and returns its final answer. */
async function runSubagent(callId: string, args: Record<string, unknown>, options: AgentOptions): Promise<string> {
	const { onEvent } = options;
	const task = typeof args.task === 'string' ? args.task.trim() : '';
	const label = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'subtask';
	if (!task) { return report(onEvent, callId, SPAWN_TOOL, args, 'spawn sub-agent', false, 'The sub-agent needs a task.'); }
	if ((options.spawnDepth ?? 0) <= 0) {
		return report(onEvent, callId, SPAWN_TOOL, args, `Sub-agent: ${label}`, false, 'Sub-agent spawning is disabled or the nesting limit was reached.');
	}
	onEvent({ type: 'toolStart', callId, tool: SPAWN_TOOL, summary: `Sub-agent: ${label}`, args });
	const maxTurns = Math.max(1, options.subagentMaxTurns ?? SUBAGENT_MAX_TURNS);
	const systemPrompt = [
		'You are a focused sub-agent helping with one subtask inside a larger coding session.',
		'Complete the task below using the available tools, then reply with a concise result: what you found or did, and any file paths involved.',
		'Do not ask questions; make reasonable assumptions and finish.',
		`You have at most ${maxTurns} turns. Call independent tools together in one turn, and leave yourself a turn for the final reply.`,
		'',
		`Subtask: ${task}`,
	].join('\n');
	const messages: ChatMessage[] = [{ role: 'user', content: task }];
	const reasoningEffort = options.subagentReasoningEffort === undefined ? options.reasoningEffort : options.subagentReasoningEffort || undefined;
	// Text from the latest turn only, so a cut-off run does not pass its narration off as a result.
	let result = '';
	let outcome: RunOutcome;
	// What the sub-agent is doing, shown live on its step: its turn, phase and streamed output.
	let turn = 0;
	let streamed = 0;
	let lastShown = '';
	let lastShownAt = 0;
	const show = (text: string, force = false) => {
		const now = Date.now();
		if (text === lastShown || (!force && now - lastShownAt < 1000)) { return; }
		lastShown = text;
		lastShownAt = now;
		onEvent({ type: 'toolProgress', callId, text });
	};
	const where = () => `turn ${turn}/${maxTurns}`;
	try {
		outcome = await runAgent({
			...options,
			systemPrompt,
			messages,
			maxTurns,
			reasoningEffort,
			spawnDepth: (options.spawnDepth ?? 1) - 1,
			// Namespaced like the tool events below, so an approval matches the step it belongs to.
			requestPermission: request => options.requestPermission({ ...request, callId: `${callId}:${request.callId}` }),
			onEvent: event => {
				if (event.type === 'text') { result += event.text; }
				if (event.type === 'phase') {
					if (event.phase === 'waiting' && !event.detail) { turn++; streamed = 0; }
					const doing = event.phase === 'tools' ? 'running tools' : event.phase === 'writingTool' ? `writing ${event.detail ?? 'a tool call'}` : event.detail ?? 'waiting for the model';
					show(`${where()} · ${doing}`, true);
				}
				if (event.type === 'text' || event.type === 'reasoning') {
					streamed += event.text.length;
					show(`${where()} · ${event.type === 'reasoning' ? 'thinking' : 'writing'} · ~${Math.ceil(streamed / 4).toLocaleString('en-US')} tokens`);
				}
				// Notices (a retry, a summary) explain a pause, so they go on the step too.
				if (event.type === 'notice') { show(`${where()} · ${event.message}`, true); }
				// Re-emit sub-agent progress so the UI can group it, tagged with the parent call.
				if (event.type === 'toolStart' || event.type === 'toolEnd' || event.type === 'toolProgress') {
					if (event.type === 'toolStart') { result = ''; }
					onEvent({ ...event, callId: `${callId}:${event.callId}` });
				}
			},
		});
	} catch (error) {
		if (options.signal?.aborted) { return finish(onEvent, callId, false, 'Stopped by the user.'); }
		return finish(onEvent, callId, false, `Sub-agent error: ${(error as Error).message}`);
	}
	if (outcome === 'aborted') { return finish(onEvent, callId, false, 'Stopped by the user.'); }
	if (outcome === 'turnLimit' || outcome === 'empty') {
		const reason = outcome === 'turnLimit' ? `ran out of turns (${maxTurns})` : 'stopped replying';
		show(`${reason}, writing a partial report`, true);
		const partial = await rescueReport(messages, options, reasoningEffort);
		return finish(onEvent, callId, false, clip(`The sub-agent ${reason} before finishing. ${partial ? `Partial report:\n${partial}` : 'It did not leave a report.'}`));
	}
	return finish(onEvent, callId, true, clip(result.trim()) || 'The sub-agent finished without a written result.');
}

/** Asks for a short report on what a cut-off sub-agent managed, so its work is not lost. */
async function rescueReport(messages: ChatMessage[], options: AgentOptions, reasoningEffort?: string): Promise<string> {
	let text = '';
	try {
		const work = flattenForSummary(messages).slice(-SUBAGENT_RESCUE_CHARS);
		const request: ChatMessage[] = [{ role: 'user', content: `${SUBAGENT_RESCUE_PROMPT}\n\n<work>\n${work}\n</work>` }];
		for await (const event of options.client.streamChat({ model: options.model, messages: request, maxTokens: options.maxTokens, reasoningEffort }, options.signal)) {
			if (event.type === 'text') { text += event.text; }
		}
	} catch {
		// Best-effort: the caller still reports the cut-off.
	}
	return text.trim();
}

function clip(text: string): string {
	return text.length > SUBAGENT_CHARS ? text.slice(0, SUBAGENT_CHARS) + '\n[... truncated ...]' : text;
}

async function previewOf(tool: Tool, args: Record<string, unknown>, context: ToolContext) {
	try {
		return await tool.preview?.(args, context);
	} catch {
		return undefined;
	}
}

function report(onEvent: AgentOptions['onEvent'], callId: string, tool: string, args: Record<string, unknown>, summary: string, ok: boolean, output: string): string {
	onEvent({ type: 'toolStart', callId, tool, summary, args });
	return finish(onEvent, callId, ok, output);
}

function finish(onEvent: AgentOptions['onEvent'], callId: string, ok: boolean, output: string): string {
	onEvent({ type: 'toolEnd', callId, ok, output });
	return output;
}
