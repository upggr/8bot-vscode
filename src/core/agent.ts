import { decide, PermissionMode, rememberKey, ToolKind } from './permissions';
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

export type AgentEvent =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'toolStart'; callId: string; tool: string; summary: string; args: Record<string, unknown> }
	| { type: 'toolEnd'; callId: string; ok: boolean; output: string }
	| { type: 'usage'; usage: Usage }
	| { type: 'notice'; message: string };

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
	reasoningEffort?: string;
	supportsTools?: boolean;
	getMode(): PermissionMode;
	requestPermission(request: PermissionRequest): Promise<PermissionAnswer>;
	onEvent(event: AgentEvent): void;
	/** Answers remembered with "always". Pass the same set across a conversation. */
	remembered?: Set<string>;
	signal?: AbortSignal;
}

const COMPACT_THRESHOLD = 0.85;

const COMPACT_PROMPT = 'Summarize this conversation so work can continue from the summary alone. Include the user\'s goals and exact requests, decisions made, files changed, current state, and the next step. Output only the summary.';

export function toolSchemas() {
	return TOOLS.map(t => t.schema);
}

/** Replaces the conversation with a model-written summary. */
export async function compact(options: Pick<AgentOptions, 'client' | 'model' | 'systemPrompt' | 'messages' | 'signal'>): Promise<void> {
	let summary = '';
	const request = [
		{ role: 'system' as const, content: options.systemPrompt },
		...options.messages,
		{ role: 'user' as const, content: COMPACT_PROMPT },
	];
	for await (const event of options.client.streamChat({ model: options.model, messages: request }, options.signal)) {
		if (event.type === 'text') { summary += event.text; }
	}
	if (!summary.trim()) { throw new Error('The model returned an empty summary.'); }
	options.messages.splice(0, options.messages.length, { role: 'user', content: `Summary of the conversation so far:\n\n${summary}` });
}

/** Runs model turns and tools until the model finishes, is stopped, or reaches the turn limit. */
export async function runAgent(options: AgentOptions): Promise<void> {
	const { client, messages, signal, onEvent } = options;
	const remembered = options.remembered ?? new Set<string>();
	const tools = options.supportsTools === false ? undefined : toolSchemas();

	for (let turn = 0; turn < options.maxTurns; turn++) {
		let text = '';
		const calls: ToolCall[] = [];
		let finish = '';
		let usage: Usage | undefined;

		try {
			const stream = client.streamChat({
				model: options.model,
				messages: [{ role: 'system', content: options.systemPrompt }, ...messages],
				tools,
				maxTokens: options.maxTokens,
				reasoningEffort: options.reasoningEffort,
			}, signal);
			for await (const event of stream) {
				if (event.type === 'text') { text += event.text; onEvent(event); }
				else if (event.type === 'reasoning') { onEvent(event); }
				else if (event.type === 'tool_call') { calls.push(event.call); }
				else if (event.type === 'usage') { usage = event.usage; onEvent({ type: 'usage', usage }); }
				else if (event.type === 'guard') { onEvent({ type: 'notice', message: `The gateway guard flagged this request (result: ${event.result}, risk: ${event.risk}, recommendation: ${event.recommendation}).` }); }
				else { finish = event.reason; }
			}
		} catch (error) {
			if (text) { messages.push({ role: 'assistant', content: text }); }
			if (signal?.aborted) { return; }
			throw error;
		}

		if (signal?.aborted) {
			if (text) { messages.push({ role: 'assistant', content: text }); }
			return;
		}
		if (!text && calls.length === 0) {
			onEvent({ type: 'notice', message: 'The model returned an empty response.' });
			return;
		}
		messages.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text });

		if (calls.length === 0) {
			if (finish === 'length') { onEvent({ type: 'notice', message: 'The response stopped at the output token limit.' }); }
			return;
		}

		for (const call of calls) {
			const output = signal?.aborted ? 'Stopped by the user.' : await executeCall(call, options, remembered);
			messages.push({ role: 'tool', tool_call_id: call.id, content: output });
		}
		if (signal?.aborted) { return; }

		if (options.contextWindow && usage && usage.promptTokens > options.contextWindow * COMPACT_THRESHOLD) {
			onEvent({ type: 'notice', message: 'Context is nearly full, summarizing the conversation.' });
			await compact(options);
		}
	}
	onEvent({ type: 'notice', message: `Stopped after ${options.maxTurns} turns. Send "continue" to keep going.` });
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
