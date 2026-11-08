import { randomBytes } from 'node:crypto';
import { byteSize, fitRequestSize, MAX_REQUEST_BYTES } from './requestSize';
import { ChatRequest, ChatStreamer, ModelInfo, StreamEvent, ToolCall, Usage } from './types';

export const DEFAULT_BASE_URL = 'https://api.8os.com';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const AUTO_MODEL = 'auto';
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const FAILOVER_MODEL = /deepseek/i;
const MAX_RETRIES = 3;

export class GatewayError extends Error {
	constructor(message: string, readonly status?: number, readonly code?: string, readonly limitReached = false) {
		super(message);
		this.name = 'GatewayError';
	}
}

/** Remaining allowance at one limit scope, from the Pax8 limits API. */
export interface LiveLimit {
	limit: number;
	used: number;
	remaining: number;
	reached: boolean;
	period?: string;
	resetsAt?: string;
}

const SUSPENSION_MESSAGES: Record<string, string> = {
	RESELLER_SUSPENDED: 'This reseller account is suspended by the gateway.',
	CLIENT_SUSPENDED: 'This client account is suspended by the gateway.',
	KEY_DISABLED: 'This API key is disabled.',
};
const LIMIT_TEXT = /limit|budget|quota|spend.?cap|hard.?cap|insufficient|credit/i;

/** Returns a normalized base URL, refusing destinations that must never receive the key. */
export function normalizeBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new GatewayError(`Invalid gateway URL: ${raw}`);
	}
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
		throw new GatewayError('The gateway URL must use https (http is allowed only for localhost).');
	}
	if (url.hostname === '8os.ai' || url.hostname.endsWith('.8os.ai')) {
		throw new GatewayError('8os.ai is an unrelated site. The 8os gateway is https://api.8os.com.');
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}`;
}

export interface GatewayOptions {
	baseUrl: string;
	apiKey: string;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	/** Sent as X-Pax8-Task for gateway routing rules. */
	taskHint?: string;
	/** Sent as X-Pax8-Agent-ID so spend can be tracked and limited per agent. */
	agentId?: string;
	/** Sent as X-Pax8-Feature so spend can be tracked per product surface. */
	feature?: string;
	/** How long a stream may stay completely silent before it counts as hung. */
	idleTimeoutMs?: number;
	/** Called for every completed request, whichever feature made it. */
	onUsage?: (usage: Usage) => void;
}

export class GatewayClient implements ChatStreamer {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly fetchImpl: typeof fetch;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly taskHint?: string;
	private readonly agentId?: string;
	private readonly idleTimeoutMs: number;
	private readonly feature?: string;
	private readonly onUsage?: (usage: Usage) => void;
	/** Once automatic routing fails, later turns on this client skip straight to this model. */
	private failoverModel?: string;

	constructor(options: GatewayOptions) {
		this.baseUrl = normalizeBaseUrl(options.baseUrl);
		this.apiKey = options.apiKey;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
		this.taskHint = options.taskHint;
		this.agentId = options.agentId;
		this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.feature = options.feature;
		this.onUsage = options.onUsage;
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const response = await this.send('/v1/models', { method: 'GET', signal });
		const body = (await response.json()) as { data?: unknown[] };
		return (body.data ?? []).map(toModelInfo).filter((m): m is ModelInfo => m !== undefined);
	}

	/** Reads the client's spend limit. Needs a Pax8 access token, because sk-pax8 keys cannot read limits. */
	async getLiveLimit(token: string, clientId: string, signal?: AbortSignal): Promise<LiveLimit | undefined> {
		const response = await this.fetchImpl(`${this.baseUrl}/v1/control/limits/usage?clientId=${encodeURIComponent(clientId)}`, {
			headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
			signal,
		});
		if (response.status === 401 || response.status === 403) {
			throw new GatewayError('The Pax8 token was rejected or has expired.', response.status);
		}
		if (!response.ok) { throw new GatewayError(`Could not read limits (${response.status}).`, response.status); }
		const body = (await response.json()) as { client?: { limits?: { spend?: RawLimit | null } } };
		const spend = body.client?.limits?.spend;
		if (!spend || spend.limit === null || spend.limit === undefined) { return undefined; }
		const used = spend.currentUsage ?? 0;
		return {
			limit: spend.limit,
			used,
			remaining: spend.remaining ?? Math.max(spend.limit - used, 0),
			reached: spend.reached ?? false,
			period: spend.period ?? undefined,
			resetsAt: spend.periodResetTime ?? undefined,
		};
	}

	private postChat(request: ChatRequest, model: string, signal?: AbortSignal): Promise<Response> {
		const body: Record<string, unknown> = {
			model,
			messages: [],
			stream: true,
			stream_options: { include_usage: true },
		};
		if (request.tools?.length) {
			body.tools = request.tools;
			body.tool_choice = request.toolChoice ?? 'auto';
		}
		if (request.maxTokens) { body.max_tokens = request.maxTokens; }
		if (request.reasoningEffort) { body.reasoning_effort = request.reasoningEffort; }
		body.messages = fitRequestSize(request.messages, byteSize(body));
		const payload = JSON.stringify(body);
		const size = Buffer.byteLength(payload);
		if (size > MAX_REQUEST_BYTES) {
			throw new GatewayError(`This message is too large to send (${(size / 1_000_000).toFixed(1)} MB). The gateway accepts about 1 MB per request, so attach fewer or smaller files.`);
		}
		return this.send('/v1/chat/completions', {
			method: 'POST',
			// One key across retries, so a retried request is not billed twice.
			headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Idempotency-Key': uuidV7() },
			body: payload,
			signal,
		});
	}

	private async findFailoverModel(request: ChatRequest, signal?: AbortSignal): Promise<ModelInfo | undefined> {
		const models = await this.listModels(signal);
		return models.find(m => FAILOVER_MODEL.test(m.id) && (!request.tools?.length || m.supportsTools));
	}

	async *streamChat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
		// Thinking models can be silent for minutes, so only a very long silence counts as a hang.
		const watchdog = new AbortController();
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const touch = () => {
			clearTimeout(timer);
			timer = setTimeout(() => { timedOut = true; watchdog.abort(); }, this.idleTimeoutMs);
		};
		const combined = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;
		touch();
		try {
			yield* this.streamOnce(request, combined, touch);
		} catch (error) {
			if (timedOut) {
				throw new GatewayError(`The gateway stopped responding for ${Math.round(this.idleTimeoutMs / 1000)} seconds. Send "continue" to try again.`);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	private async *streamOnce(request: ChatRequest, signal: AbortSignal, touch: () => void): AsyncGenerator<StreamEvent> {
		const model = request.model === AUTO_MODEL && this.failoverModel ? this.failoverModel : request.model;
		let response: Response;
		try {
			response = await this.postChat(request, model, signal);
		} catch (error) {
			if (model !== AUTO_MODEL || !isProviderRejection(error)) { throw error; }
			const fallback = await this.findFailoverModel(request, signal).catch(() => undefined);
			if (!fallback) { throw error; }
			this.failoverModel = fallback.id;
			yield { type: 'failover', model: fallback.id, name: fallback.name, contextWindow: fallback.contextWindow };
			response = await this.postChat(request, fallback.id, signal);
		}
		touch();
		if (!response.body) {
			throw new GatewayError('The gateway returned an empty response.');
		}
		const guardResult = response.headers.get('x-pax8-guard-result');
		const risk = response.headers.get('x-pax8-ai-risk');
		if ((guardResult && guardResult !== 'allowed') || (risk && risk !== 'ok')) {
			yield { type: 'guard', result: guardResult ?? 'unknown', risk: risk ?? 'unknown', recommendation: response.headers.get('x-pax8-guard-recommendation') ?? 'none' };
		}

		const calls = new Map<number, ToolCall>();
		for await (const data of readSse(response.body)) {
			touch();
			if (data === '[DONE]') { break; }
			let chunk: GatewayChunk;
			try {
				chunk = JSON.parse(data) as GatewayChunk;
			} catch {
				continue;
			}
			if (chunk.error) {
				throw new GatewayError(this.redact(chunk.error.message ?? 'The gateway reported an error.'));
			}
			const choice = chunk.choices?.[0];
			const delta = choice?.delta;
			if (delta?.content) { yield { type: 'text', text: delta.content }; }
			const reasoning = delta?.reasoning_content ?? delta?.reasoning;
			if (typeof reasoning === 'string' && reasoning) { yield { type: 'reasoning', text: reasoning }; }
			for (const part of delta?.tool_calls ?? []) {
				const index = part.index ?? 0;
				let call = calls.get(index);
				if (!call) {
					call = { id: '', type: 'function', function: { name: '', arguments: '' } };
					calls.set(index, call);
				}
				if (part.id && !call.id) { call.id = part.id; }
				if (part.function?.name && !call.function.name) { call.function.name = part.function.name; }
				if (part.function?.arguments) { call.function.arguments += part.function.arguments; }
			}
			if (chunk.usage) {
				const usage = toUsage(chunk.usage, chunk.model);
				this.onUsage?.(usage);
				yield { type: 'usage', usage };
			}
			if (choice?.finish_reason) {
				for (const [index, call] of [...calls].sort((a, b) => a[0] - b[0])) {
					if (!call.id) { call.id = `call_${index}_${Math.random().toString(36).slice(2, 10)}`; }
					yield { type: 'tool_call', call };
				}
				calls.clear();
				yield { type: 'finish', reason: choice.finish_reason };
			}
		}
	}

	private async send(path: string, init: RequestInit): Promise<Response> {
		const headers: Record<string, string> = { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.apiKey}` };
		if (this.taskHint) { headers['X-Pax8-Task'] = this.taskHint; }
		if (this.agentId) { headers['X-Pax8-Agent-ID'] = this.agentId; }
		if (this.feature) { headers['X-Pax8-Feature'] = this.feature; }
		let freshKeyTried = false;
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
			} catch (error) {
				if (init.signal?.aborted) { throw error; }
				if (attempt >= MAX_RETRIES) {
					throw new GatewayError(`Could not reach the gateway: ${this.redact(String(error))}`);
				}
				await this.sleep(backoff(attempt));
				continue;
			}
			if (response.ok) { return response; }
			// The gateway also answers 401 when an idempotency key is reused, so a retry gets one fresh key.
			if (response.status === 401 && attempt > 0 && headers['Idempotency-Key'] && !freshKeyTried) {
				freshKeyTried = true;
				headers['Idempotency-Key'] = uuidV7();
				continue;
			}
			if (RETRYABLE.has(response.status) && attempt < MAX_RETRIES) {
				const text = await response.text().catch(() => '');
				if (response.status === 429 && LIMIT_TEXT.test(text)) { throw this.toError(response.status, text); }
				const retryAfter = Number(response.headers.get('retry-after'));
				await this.sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : backoff(attempt));
				continue;
			}
			throw this.toError(response.status, await response.text().catch(() => ''));
		}
	}

	private toError(status: number, text: string): GatewayError {
		const { code, message } = parseError(text);
		if (code && SUSPENSION_MESSAGES[code]) { return new GatewayError(SUSPENSION_MESSAGES[code], status, code); }
		if (status === 401) { return new GatewayError('The gateway rejected your API key (401). Run "8bot: Set API Key".', status, code); }
		const limitReached = status === 402 || ((status === 403 || status === 429) && LIMIT_TEXT.test(`${code ?? ''} ${message}`));
		if (limitReached) { return new GatewayError(`Your gateway spending or usage limit has been reached. ${this.redact(message).slice(0, 300)}`.trim(), status, code, true); }
		return new GatewayError(`Gateway error ${status}: ${this.redact(message).slice(0, 500)}`, status, code);
	}

	private redact(text: string): string {
		return this.apiKey ? text.split(this.apiKey).join('***') : text;
	}
}

interface RawLimit {
	limit?: number | null;
	currentUsage?: number | null;
	remaining?: number | null;
	reached?: boolean;
	period?: string | null;
	periodResetTime?: string | null;
}

/** The gateway's automatic routing intermittently picks a provider that refuses the request. */
export function isProviderRejection(error: unknown): boolean {
	return error instanceof GatewayError && error.status === 400 && /model provider rejected/i.test(error.message);
}

function parseError(text: string): { code?: string; message: string } {
	try {
		const body = JSON.parse(text) as {
			error?: { code?: string; message?: string } | string;
			message?: string;
			details?: { code?: string; message?: string }[];
		};
		if (typeof body.error === 'string') { return { message: body.error }; }
		const detail = body.details?.[0];
		return { code: body.error?.code ?? detail?.code, message: body.error?.message ?? detail?.message ?? body.message ?? text };
	} catch {
		return { message: text };
	}
}

interface GatewayChunk {
	model?: string;
	error?: { message?: string };
	usage?: RawUsage;
	choices?: {
		finish_reason?: string | null;
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
		};
	}[];
}

interface RawUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	cost?: number;
	cache_read_input_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; cache_creation_tokens?: number };
	completion_tokens_details?: { reasoning_tokens?: number };
}

function toUsage(raw: RawUsage, model?: string): Usage {
	return {
		promptTokens: raw.prompt_tokens ?? 0,
		completionTokens: raw.completion_tokens ?? 0,
		cost: raw.cost,
		cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens,
		cacheWriteTokens: raw.prompt_tokens_details?.cache_write_tokens ?? raw.prompt_tokens_details?.cache_creation_tokens,
		reasoningTokens: raw.completion_tokens_details?.reasoning_tokens,
		model,
	};
}

/** The gateway requires UUID v7 for Idempotency-Key. */
export function uuidV7(now = Date.now()): string {
	const bytes = randomBytes(16);
	bytes.writeUIntBE(now, 0, 6);
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function backoff(attempt: number): number {
	return 500 * 2 ** attempt;
}

/** Yields the `data:` payload of each server-sent event. */
export async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buffer = '';
	let data: string[] = [];
	try {
		for (;;) {
			const { value, done } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, '');
				buffer = buffer.slice(newline + 1);
				if (line === '') {
					if (data.length) { yield data.join('\n'); data = []; }
				} else if (line.startsWith('data:')) {
					data.push(line.slice(5).replace(/^ /, ''));
				}
			}
			if (done) {
				if (buffer.startsWith('data:')) { data.push(buffer.slice(5).replace(/^ /, '')); }
				if (data.length) { yield data.join('\n'); }
				return;
			}
		}
	} finally {
		// Not awaited: the gateway can end a stream with a malformed chunk, and cleanup must never block.
		void reader.cancel().catch(() => undefined);
	}
}

function toModelInfo(raw: unknown): ModelInfo | undefined {
	const m = raw as {
		id?: string; display_name?: string; displayName?: string; modelFamily?: string; description?: string;
		contextWindow?: number; max_input_tokens?: number; maxOutputTokens?: number; lifecycleStatus?: string;
		capabilities?: string[]; inputModalities?: string[]; outputModalities?: string[];
		features?: { tools?: boolean; vision?: boolean; reasoningEfforts?: string[] };
		deprecationInfo?: { deprecatedAt?: string | null; sunsetAt?: string | null; replacedBy?: string | null } | null;
	};
	if (!m.id) { return undefined; }
	if (m.lifecycleStatus && m.lifecycleStatus !== 'ACTIVE') { return undefined; }
	if (m.capabilities && !m.capabilities.includes('CHAT_COMPLETION')) { return undefined; }
	return {
		id: m.id,
		name: m.display_name ?? m.displayName ?? m.id,
		family: (m.modelFamily ?? m.id).toLowerCase(),
		description: m.description,
		contextWindow: m.contextWindow ?? m.max_input_tokens ?? 128_000,
		maxOutputTokens: m.maxOutputTokens ?? 8_192,
		supportsTools: m.features?.tools ?? true,
		supportsImages: (m.features?.vision ?? false) || (m.inputModalities?.includes('IMAGE') ?? false),
		reasoningEfforts: m.features?.reasoningEfforts ?? [],
		deprecatedAt: m.deprecationInfo?.deprecatedAt ?? undefined,
		inputModalities: m.inputModalities ?? ['TEXT'],
		outputModalities: m.outputModalities ?? ['TEXT'],
	};
}
