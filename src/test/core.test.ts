import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { compact, runAgent, withCacheMarkers, AgentEvent, PermissionAnswer } from '../core/agent';
import { compactLimit, compactionCut, estimateTokens, keepTokensFor, flattenForSummary, looksLikeOverflow, trimForRequest } from '../core/context';
import { addSpend, creditStatus } from '../core/credits';
import { GatewayClient, GatewayError, normalizeBaseUrl } from '../core/gateway';
import { addMemory, readMemory } from '../core/memory';
import { decide, PermissionMode, rememberKey } from '../core/permissions';
import { buildSystemPrompt } from '../core/prompt';
import { newSession, SessionStore } from '../core/sessions';
import { findTool, globToRegExp, isSensitivePath, ToolContext } from '../core/tools';
import { ChatMessage, ChatStreamer, StreamEvent, ToolCall } from '../core/types';

const KEY = 'sk-pax8-testkey';

function sse(res: ServerResponse, chunks: object[], headers: Record<string, string> = {}): void {
	res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
	for (const chunk of chunks) { res.write(`data: ${JSON.stringify(chunk)}\n\n`); }
	res.end('data: [DONE]\n\n');
}

let server: Server;
let base: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;

before(async () => {
	server = createServer((req, res) => handler(req, res));
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const client = (extra = {}) => new GatewayClient({ baseUrl: base, apiKey: KEY, sleep: async () => undefined, ...extra });

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const event of gen) { out.push(event); }
	return out;
}

test('base URL rules protect the key', () => {
	assert.equal(normalizeBaseUrl('https://api.8os.com/v1/'), 'https://api.8os.com');
	assert.throws(() => normalizeBaseUrl('http://api.8os.com'), GatewayError);
	assert.throws(() => normalizeBaseUrl('https://8os.ai'), /unrelated/);
	assert.equal(normalizeBaseUrl('http://localhost:4000'), 'http://localhost:4000');
});

test('assembles streamed tool calls whose id arrives only once', async () => {
	let auth: string | undefined;
	let task: string | undefined;
	let idempotency: string | undefined;
	let agent: string | undefined;
	let feature: string | undefined;
	handler = (req, res) => {
		auth = req.headers.authorization;
		task = req.headers['x-pax8-task'] as string;
		idempotency = req.headers['idempotency-key'] as string;
		agent = req.headers['x-pax8-agent-id'] as string;
		feature = req.headers['x-pax8-feature'] as string;
		sse(res, [
			{ model: 'routed', choices: [{ delta: { content: 'Hi', tool_calls: [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] } }] },
			{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
			{ model: 'routed', choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.5 } },
		]);
	};
	const costs: number[] = [];
	const events = await collect(client({ taskHint: 'coding', agentId: '8bot-vscode', feature: 'sidebar', onUsage: (u: { cost: number }) => costs.push(u.cost) }).streamChat({ model: 'm', messages: [] }));
	assert.equal(auth, `Bearer ${KEY}`);
	assert.equal(task, 'coding');
	const call = events.find(e => e.type === 'tool_call') as { call: ToolCall };
	assert.deepEqual(call.call, { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } });
	assert.deepEqual(costs, [0.5]);
	const usage = events.find(e => e.type === 'usage') as { usage: { model: string } };
	assert.equal(usage.usage.model, 'routed');
	assert.match(idempotency ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.equal(agent, '8bot-vscode');
	assert.equal(feature, 'sidebar');
});

const REJECTED = JSON.stringify({ type: 'error', error: { message: 'The model provider rejected this request. Check the model, parameters and input size, then retry; if the problem persists, contact support with the correlation_id.', type: 'invalid_request_error', code: '400', correlation_id: 'x' } });
const DEEPSEEK_MODELS = { data: [
	{ id: 'claude', display_name: 'Claude' },
	{ id: 'deepseek-no-tools', display_name: 'No Tools', features: { tools: false } },
	{ id: 'deepseek-v4-pro', display_name: 'DeepSeek V4 Pro', features: { tools: true } },
	{ id: 'deepseek-v4.1-flash', display_name: 'DeepSeek Flash', features: { tools: true } },
] };
const TOOL = { type: 'function' as const, function: { name: 't', description: 'd', parameters: {} } };

function failoverGateway(models: object, rejection = REJECTED) {
	const used: string[] = [];
	handler = (req, res) => {
		if (req.method === 'GET') { res.end(JSON.stringify(models)); return; }
		let raw = '';
		req.on('data', c => { raw += c; });
		req.on('end', () => {
			const { model } = JSON.parse(raw) as { model: string };
			used.push(model);
			if (model === 'auto') { res.writeHead(400).end(rejection); return; }
			sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
		});
	};
	return used;
}

test('auto fails over to a tool-capable DeepSeek model and stays there', async () => {
	const used = failoverGateway(DEEPSEEK_MODELS);
	const c = client();
	const first = await collect(c.streamChat({ model: 'auto', messages: [], tools: [TOOL] }));
	assert.deepEqual(first[0], { type: 'failover', model: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 128000 });
	assert.ok(first.some(e => e.type === 'text'));
	const second = await collect(c.streamChat({ model: 'auto', messages: [], tools: [TOOL] }));
	assert.ok(!second.some(e => e.type === 'failover'));
	assert.deepEqual(used, ['auto', 'deepseek-v4-pro', 'deepseek-v4-pro']);
});

test('no failover for a chosen model, another 400, or when DeepSeek is unavailable', async () => {
	let used = failoverGateway(DEEPSEEK_MODELS);
	handler = (req, res) => { used.push('x'); req.resume(); res.writeHead(400).end(REJECTED); };
	await assert.rejects(collect(client().streamChat({ model: 'claude', messages: [] })), /model provider rejected/);
	assert.deepEqual(used, ['x']);

	used = failoverGateway(DEEPSEEK_MODELS, JSON.stringify({ error: { message: 'messages is required' } }));
	await assert.rejects(collect(client().streamChat({ model: 'auto', messages: [] })), /messages is required/);
	assert.deepEqual(used, ['auto']);

	used = failoverGateway({ data: [{ id: 'claude' }] });
	await assert.rejects(collect(client().streamChat({ model: 'auto', messages: [] })), /model provider rejected/);
	assert.deepEqual(used, ['auto']);
});

test('the agent tells the user about a failover', async () => {
	const { root, clean } = workspace();
	try {
		const events: AgentEvent[] = [];
		const stream = scripted([[{ type: 'failover', model: 'd', name: 'DeepSeek', contextWindow: 1000 }, say('ok')]]);
		await runAgent(agentOptions(stream, root, 'default', 'allow', events));
		assert.ok(events.some(e => e.type === 'notice' && e.message.includes('DeepSeek')));
	} finally { clean(); }
});

test('reports gateway guard flags', async () => {
	handler = (_req, res) => sse(res, [{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }], { 'x-pax8-guard-result': 'flagged', 'x-pax8-ai-risk': 'high' });
	const events = await collect(client().streamChat({ model: 'm', messages: [] }));
	assert.deepEqual(events[0], { type: 'guard', result: 'flagged', risk: 'high', recommendation: 'none' });
});

test('retries keep the same idempotency key', async () => {
	const keys: unknown[] = [];
	handler = (req, res) => {
		keys.push(req.headers['idempotency-key']);
		if (keys.length < 2) { res.writeHead(502).end(); return; }
		sse(res, [{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]);
	};
	await collect(client().streamChat({ model: 'm', messages: [] }));
	assert.equal(keys.length, 2);
	assert.equal(keys[0], keys[1]);
});

test('retries temporary failures and never leaks the key', async () => {
	let calls = 0;
	handler = (_req, res) => {
		calls++;
		if (calls < 3) { res.writeHead(503).end(); return; }
		res.writeHead(400).end(JSON.stringify({ error: { message: `bad ${KEY}` } }));
	};
	await assert.rejects(collect(client().streamChat({ model: 'm', messages: [] })), (e: GatewayError) => {
		assert.equal(calls, 3);
		assert.ok(!e.message.includes(KEY));
		return e.status === 400;
	});
});

test('a spending limit is not retried and is marked as reached', async () => {
	let calls = 0;
	handler = (_req, res) => { calls++; res.writeHead(429).end(JSON.stringify({ error: { code: 'SPEND_LIMIT_EXCEEDED', message: 'Budget hit' } })); };
	await assert.rejects(collect(client().streamChat({ model: 'm', messages: [] })), (e: GatewayError) => e.limitReached && calls === 1);
});

test('explains suspended keys', async () => {
	handler = (_req, res) => res.writeHead(403).end(JSON.stringify({ error: { code: 'KEY_DISABLED', type: 'permission_error', message: 'no' } }));
	await assert.rejects(collect(client().streamChat({ model: 'm', messages: [] })), /disabled/);
});

test('maps models and hides inactive ones', async () => {
	handler = (_req, res) => res.end(JSON.stringify({ data: [
		{ id: 'a', display_name: 'A', lifecycleStatus: 'ACTIVE', capabilities: ['CHAT_COMPLETION'], contextWindow: 10, maxOutputTokens: 5, features: { tools: true, vision: true, reasoningEfforts: ['low'] } },
		{ id: 'b', lifecycleStatus: 'RETIRED', capabilities: ['CHAT_COMPLETION'] },
		{ id: 'c', lifecycleStatus: 'ACTIVE', capabilities: ['EMBEDDING'] },
	] }));
	const models = await client().listModels();
	assert.deepEqual(models.map(m => m.id), ['a']);
	assert.equal(models[0].supportsImages, true);
	assert.deepEqual(models[0].reasoningEfforts, ['low']);
});

test('reads a live limit using the Pax8 token, not the key', async () => {
	let auth: string | undefined;
	let url: string | undefined;
	handler = (req, res) => {
		auth = req.headers.authorization;
		url = req.url;
		res.end(JSON.stringify({ client: { limits: { spend: { limit: 10, currentUsage: 4, remaining: 6, reached: false, period: 'monthly' } } }, agents: [] }));
	};
	const live = await client().getLiveLimit('jwt', 'c1');
	assert.equal(auth, 'Bearer jwt');
	assert.equal(url, '/v1/control/limits/usage?clientId=c1');
	assert.equal(live?.remaining, 6);
	assert.equal(creditStatus(undefined, 0, live).label, '$6.00 left');
	assert.equal(creditStatus(undefined, 0, live).live, true);
});

test('local credits reset each month and show what is left', () => {
	const october = new Date('2026-10-31T12:00:00Z');
	const november = new Date('2026-11-01T12:00:00Z');
	const record = addSpend(addSpend(undefined, 1, october), 2, october);
	assert.equal(record.total, 3);
	assert.equal(addSpend(record, 1, november).total, 1);
	assert.equal(creditStatus(record, 5, undefined, october).label, '$2.00 left');
	assert.equal(creditStatus(record, 3, undefined, october).level, 'empty');
	assert.equal(creditStatus(record, 0, undefined, october).label, '$3.00 this month');
	assert.equal(creditStatus(record, 5, undefined, november).label, '$5.00 left');
});

test('permission policy', () => {
	const expected: [PermissionMode, Parameters<typeof decide>[1], string][] = [
		['default', 'read', 'allow'], ['default', 'edit', 'ask'], ['default', 'execute', 'ask'], ['default', 'sensitiveRead', 'ask'],
		['acceptEdits', 'edit', 'allow'], ['acceptEdits', 'sensitiveEdit', 'ask'], ['acceptEdits', 'execute', 'ask'],
		['plan', 'read', 'allow'], ['plan', 'edit', 'deny'], ['plan', 'sensitiveEdit', 'deny'], ['plan', 'execute', 'deny'],
		['bypassPermissions', 'execute', 'allow'], ['bypassPermissions', 'sensitiveEdit', 'allow'],
	];
	for (const [mode, kind, decision] of expected) { assert.equal(decide(mode, kind), decision, `${mode}/${kind}`); }
	assert.equal(rememberKey('run_command', { command: 'git status' }), 'run_command:git status');
	assert.equal(rememberKey('edit_file', { path: 'a' }), 'edit_file');
});

test('sensitive path detection', () => {
	for (const p of ['.env', 'a/.env.local', 'id_rsa', 'x/server.pem', '/home/me/.ssh/config', '.npmrc']) { assert.ok(isSensitivePath(p), p); }
	for (const p of ['.env.example', 'src/index.ts', 'keyboard.ts']) { assert.ok(!isSensitivePath(p), p); }
});

test('glob matching', () => {
	assert.ok(globToRegExp('src/**/*.ts').test('src/a/b.ts'));
	assert.ok(globToRegExp('src/**/*.ts').test('src/b.ts'));
	assert.ok(globToRegExp('*.{js,ts}').test('a.ts'));
	assert.ok(!globToRegExp('*.ts').test('a/b.ts'));
});

function workspace(): { root: string; ctx: ToolContext; clean: () => void } {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '8bot-test-')));
	return { root, ctx: { root, allowOutsideWorkspace: false, commandTimeoutSeconds: 5 }, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const tool = (name: string) => findTool(name)!;

test('workspace boundary blocks traversal and symlinks', async () => {
	const { root, ctx, clean } = workspace();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), '8bot-out-'));
	try {
		fs.writeFileSync(path.join(outside, 's.txt'), 'secret');
		fs.symlinkSync(outside, path.join(root, 'link'));
		await assert.rejects(tool('read_file').run({ path: '../x' }, ctx), /outside the workspace/);
		await assert.rejects(tool('read_file').run({ path: 'link/s.txt' }, ctx), /outside the workspace/);
		await assert.rejects(tool('write_file').run({ path: 'link/new.txt', content: 'x' }, ctx), /outside the workspace/);
		assert.match(await tool('read_file').run({ path: path.join(outside, 's.txt') }, { ...ctx, allowOutsideWorkspace: true }), /secret/);
	} finally {
		clean();
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test('edit requires a unique match', async () => {
	const { root, ctx, clean } = workspace();
	try {
		fs.writeFileSync(path.join(root, 'a.txt'), 'x x y');
		await assert.rejects(tool('edit_file').run({ path: 'a.txt', old_string: 'x', new_string: 'z' }, ctx), /2 times/);
		await assert.rejects(tool('edit_file').run({ path: 'a.txt', old_string: 'q', new_string: 'z' }, ctx), /not found/);
		await tool('edit_file').run({ path: 'a.txt', old_string: 'x', new_string: 'z', replace_all: true }, ctx);
		assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'z z y');
	} finally { clean(); }
});

test('search skips secrets and dependency folders', async () => {
	const { root, ctx, clean } = workspace();
	try {
		fs.writeFileSync(path.join(root, '.env'), 'NEEDLE=1');
		fs.writeFileSync(path.join(root, 'a.ts'), 'NEEDLE');
		fs.mkdirSync(path.join(root, 'node_modules'));
		fs.writeFileSync(path.join(root, 'node_modules', 'b.ts'), 'NEEDLE');
		assert.equal(await tool('search_text').run({ pattern: 'NEEDLE' }, ctx), 'a.ts:1:NEEDLE');
	} finally { clean(); }
});

test('commands report exit codes, time out and hide the API key', async () => {
	const { ctx, clean } = workspace();
	process.env.EIGHTOS_API_KEY = KEY;
	try {
		assert.match(await tool('run_command').run({ command: 'echo hi; exit 3' }, ctx), /hi\s+Exit code 3/);
		assert.match(await tool('run_command').run({ command: 'sleep 5', timeout_seconds: 0.2 }, ctx), /Timed out/);
		assert.ok(!(await tool('run_command').run({ command: 'echo "[$EIGHTOS_API_KEY]"' }, ctx)).includes(KEY));
	} finally {
		delete process.env.EIGHTOS_API_KEY;
		clean();
	}
});

test('editing .vscode or secrets is classed as sensitive', () => {
	const ctx = { root: '/', allowOutsideWorkspace: false, commandTimeoutSeconds: 1 };
	assert.equal(tool('write_file').kind({ path: '.vscode/tasks.json' }, ctx), 'sensitiveEdit');
	assert.equal(tool('edit_file').kind({ path: '.git/hooks/pre-commit' }, ctx), 'sensitiveEdit');
	assert.equal(tool('read_file').kind({ path: '.env' }, ctx), 'sensitiveRead');
	assert.equal(tool('write_file').kind({ path: 'src/a.ts' }, ctx), 'edit');
});

function scripted(turns: StreamEvent[][]): ChatStreamer & { requests: ChatMessage[][] } {
	const requests: ChatMessage[][] = [];
	return {
		requests,
		async *streamChat(request) {
			requests.push(request.messages.map(m => ({ ...m })));
			for (const event of turns[requests.length - 1] ?? []) { yield event; }
		},
	};
}

const call = (id: string, name: string, args: object): StreamEvent => ({ type: 'tool_call', call: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } } });
const say = (text: string): StreamEvent => ({ type: 'text', text });

function agentOptions(stream: ChatStreamer, root: string, mode: PermissionMode, answer: PermissionAnswer, sink: AgentEvent[], messages: ChatMessage[] = [{ role: 'user', content: 'go' }]) {
	return {
		client: stream, model: 'm', systemPrompt: 's', messages, root, commandTimeoutSeconds: 5, maxTurns: 5,
		getMode: () => mode, requestPermission: async () => answer, onEvent: (e: AgentEvent) => sink.push(e),
	};
}

test('agent asks in default mode, runs the tool and feeds back the result', async () => {
	const { root, clean } = workspace();
	try {
		const stream = scripted([[call('1', 'write_file', { path: 'n.txt', content: 'v' })], [say('done')]]);
		const events: AgentEvent[] = [];
		await runAgent(agentOptions(stream, root, 'default', 'allow', events));
		assert.equal(fs.readFileSync(path.join(root, 'n.txt'), 'utf8'), 'v');
		assert.equal(stream.requests[1].at(-1)?.role, 'tool');
		assert.equal(stream.requests[1].at(-1)?.tool_call_id, '1');
		assert.ok(events.some(e => e.type === 'toolEnd' && e.ok));
	} finally { clean(); }
});

test('denied and plan-mode actions never touch the disk', async () => {
	const { root, clean } = workspace();
	try {
		await runAgent(agentOptions(scripted([[call('1', 'write_file', { path: 'a', content: 'v' })], [say('ok')]]), root, 'default', 'deny', []));
		await runAgent(agentOptions(scripted([[call('1', 'run_command', { command: 'touch b' })], [say('ok')]]), root, 'plan', 'allow', []));
		assert.deepEqual(fs.readdirSync(root), []);
	} finally { clean(); }
});

test('bypass mode never asks', async () => {
	const { root, clean } = workspace();
	try {
		const options = { ...agentOptions(scripted([[call('1', 'run_command', { command: 'touch c' })], [say('ok')]]), root, 'bypassPermissions', 'deny', []), requestPermission: async (): Promise<PermissionAnswer> => { throw new Error('asked'); } };
		await runAgent(options);
		assert.deepEqual(fs.readdirSync(root), ['c']);
	} finally { clean(); }
});

test('an always answer for one command does not approve a different one', async () => {
	const { root, clean } = workspace();
	try {
		const asked: string[] = [];
		const stream = scripted([
			[call('1', 'run_command', { command: 'echo a' })],
			[call('2', 'run_command', { command: 'echo a' })],
			[call('3', 'run_command', { command: 'echo a; touch z' })],
			[say('ok')],
		]);
		await runAgent({ ...agentOptions(stream, root, 'default', 'always', []), requestPermission: async r => { asked.push(String(r.args.command)); return r.args.command === 'echo a' ? 'always' : 'deny'; } });
		assert.deepEqual(asked, ['echo a', 'echo a; touch z']);
		assert.deepEqual(fs.readdirSync(root), []);
	} finally { clean(); }
});

test('invalid tool arguments go back to the model and every call gets a result', async () => {
	const { root, clean } = workspace();
	try {
		const bad: StreamEvent = { type: 'tool_call', call: { id: '1', type: 'function', function: { name: 'read_file', arguments: '{oops' } } };
		const stream = scripted([[bad, call('2', 'nope', {})], [say('ok')]]);
		await runAgent(agentOptions(stream, root, 'default', 'allow', []));
		const tools = stream.requests[1].filter(m => m.role === 'tool');
		assert.deepEqual(tools.map(m => m.tool_call_id), ['1', '2']);
		assert.match(String(tools[0].content), /not valid JSON/);
	} finally { clean(); }
});

test('stopping mid-run still answers every tool call so history stays valid', async () => {
	const { root, clean } = workspace();
	try {
		const abort = new AbortController();
		const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
		const stream = scripted([[call('1', 'run_command', { command: 'echo a' }), call('2', 'run_command', { command: 'echo b' })]]);
		await runAgent({ ...agentOptions(stream, root, 'default', 'allow', [], messages), signal: abort.signal, requestPermission: async () => { abort.abort(); return 'deny'; } });
		assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['1', '2']);
	} finally { clean(); }
});

test('context is summarized when nearly full', async () => {
	const { root, clean } = workspace();
	try {
		const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
		const stream = scripted([
			[call('1', 'list_files', {}), { type: 'usage', usage: { promptTokens: 90, completionTokens: 1 } }],
			[say('the summary')],
			[say('finished')],
		]);
		await runAgent({ ...agentOptions(stream, root, 'default', 'allow', [], messages), contextWindow: 100 });
		assert.match(String(messages[0].content), /the summary/);
		assert.equal(messages.at(-1)?.content, 'finished');
	} finally { clean(); }
});

const toolTurn = (id: string, name: string, args: object, output: string): ChatMessage[] => [
	{ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
	{ role: 'tool', tool_call_id: id, content: output },
];

test('an earlier read of the same file is dropped from the request but kept in the chat', () => {
	const messages: ChatMessage[] = [
		{ role: 'user', content: 'go' },
		...toolTurn('1', 'read_file', { path: 'a.ts' }, 'old content'),
		...toolTurn('2', 'read_file', { path: 'b.ts' }, 'other file'),
		...toolTurn('3', 'read_file', { path: 'a.ts' }, 'new content'),
	];
	const sent = trimForRequest(messages);
	assert.match(String(sent[2].content), /Superseded/);
	assert.equal(sent[4].content, 'other file');
	assert.equal(sent[6].content, 'new content');
	assert.equal(messages[2].content, 'old content');
});

test('old tool output is shortened past the limit and recent output is untouched', () => {
	const big = 'x'.repeat(40_000);
	const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
	for (let i = 0; i < 12; i++) { messages.push(...toolTurn(String(i), 'run_command', { command: `c${i}` }, big)); }
	const sent = trimForRequest(messages, 100_000);
	const tools = sent.filter(m => m.role === 'tool');
	assert.match(String(tools[0].content), /Older output removed/);
	assert.ok(tools.slice(-8).every(m => m.content === big));
	assert.ok(estimateTokens(sent) < estimateTokens(messages));
	assert.equal(messages[2].content, big);
	assert.ok(trimForRequest(messages, 1_000_000).filter(m => m.role === 'tool').every(m => m.content === big), 'large models keep everything until they are well filled');
});

test('compaction never starts the kept part on a tool result', () => {
	const big = 'y'.repeat(100_000);
	const messages: ChatMessage[] = [{ role: 'user', content: 'a' }, ...toolTurn('1', 'run_command', { command: 'x' }, big), { role: 'user', content: 'b' }, ...toolTurn('2', 'run_command', { command: 'y' }, 'small')];
	const cut = compactionCut(messages, 1_000);
	assert.notEqual(messages[cut].role, 'tool');
	assert.equal(cut, 3);
	assert.equal(compactionCut([{ role: 'user', content: 'only' }], 1_000), 0);
});

test('compaction keeps recent work, returns what it removed and sends no tool messages', async () => {
	const messages: ChatMessage[] = [{ role: 'user', content: 'first' }, ...toolTurn('1', 'run_command', { command: 'x' }, 'z'.repeat(100_000)), { role: 'user', content: 'latest' }];
	const stream = scripted([[say('short summary')]]);
	const removed = await compact({ client: stream, model: 'm', messages }, 1_000);
	assert.equal(removed.length, 3);
	assert.equal(messages.length, 2);
	assert.match(String(messages[0].content), /short summary/);
	assert.equal(messages[1].content, 'latest');
	assert.ok(stream.requests[0].every(m => m.role === 'user'));
	assert.deepEqual(await compact({ client: stream, model: 'm', messages: [{ role: 'user', content: 'x' }] }), []);
});

test('summaries shorten tool output', () => {
	const text = flattenForSummary(toolTurn('1', 'run_command', { command: 'x' }, 'q'.repeat(9_000)));
	assert.ok(text.length < 3_000);
	assert.match(text, /called run_command/);
});

test('cache markers cover the system prompt, and the latest message only on verified models', () => {
	const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
	const claude = withCacheMarkers('s', messages, 'claude-haiku-5-5');
	assert.deepEqual(claude[0].content, [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }]);
	assert.deepEqual(claude[1].content, [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]);
	assert.equal(withCacheMarkers('s', messages, 'gpt-5')[1].content, 'hi');
	assert.equal(messages[0].content, 'hi');
});

test('overflow detection uses clear errors, or the generic rejection on a large request', () => {
	const generic = new GatewayError('Gateway error 400: The model provider rejected this request.', 400);
	assert.ok(looksLikeOverflow(new GatewayError('context_length_exceeded', 400), 1, 100));
	assert.ok(looksLikeOverflow(generic, 50, 100));
	assert.ok(!looksLikeOverflow(generic, 10, 100));
	assert.ok(!looksLikeOverflow(new GatewayError('bad model', 400), 90, 100));
});

test('a too-large request is summarized and retried once', async () => {
	const { root, clean } = workspace();
	try {
		const messages: ChatMessage[] = [{ role: 'user', content: 'old' }, ...toolTurn('1', 'run_command', { command: 'x' }, 'z'.repeat(200_000)), { role: 'user', content: 'now' }];
		let calls = 0;
		const stream: ChatStreamer = {
			async *streamChat() {
				calls++;
				if (calls === 1 || calls === 3) { if (calls === 1) { throw new GatewayError('context_length_exceeded', 400); } }
				yield say(calls === 2 ? 'the summary' : 'answered');
			},
		};
		const events: AgentEvent[] = [];
		await runAgent(agentOptions(stream, root, 'default', 'allow', events, messages));
		assert.equal(calls, 3);
		assert.equal(messages.at(-1)?.content, 'answered');
		assert.ok(events.some(e => e.type === 'compacted'));

		let failures = 0;
		const always: ChatStreamer = { async *streamChat() { failures++; if (failures !== 2) { throw new GatewayError('context_length_exceeded', 400); } yield say('s'); } };
		const again: ChatMessage[] = [{ role: 'user', content: 'old' }, ...toolTurn('1', 'run_command', { command: 'x' }, 'z'.repeat(200_000)), { role: 'user', content: 'now' }];
		await assert.rejects(runAgent(agentOptions(always, root, 'default', 'allow', [], again)), /context_length/);
		assert.equal(failures, 3);
	} finally { clean(); }
});

test('memory saves, avoids duplicates, removes and survives across chats', async () => {
	const { root, ctx, clean } = workspace();
	try {
		const file = path.join(root, 'nested', 'memory.md');
		const withMemory = { ...ctx, memoryFile: file };
		assert.equal(await tool('remember').run({ note: 'Uses  pnpm\nnot npm' }, withMemory), 'Saved to memory.');
		assert.equal(await tool('remember').run({ note: 'Uses pnpm not npm' }, withMemory), 'That note was already saved.');
		await addMemory(file, 'Deploys to Coolify');
		assert.equal(await readMemory(file), '- Uses pnpm not npm\n- Deploys to Coolify');
		assert.match(buildSystemPrompt({ root, mode: 'default', memory: await readMemory(file) }), /Saved memory[\s\S]*Deploys to Coolify/);
		assert.equal(await tool('forget').run({ text: 'PNPM' }, withMemory), 'Removed 1 notes.');
		assert.equal(await readMemory(file), '- Deploys to Coolify');
		await assert.rejects(tool('remember').run({ note: 'x' }, ctx), /not available/);
		assert.equal(tool('remember').kind({}, ctx), 'edit');
		assert.equal(decide('plan', tool('remember').kind({}, ctx)), 'deny');
	} finally { clean(); }
});

test('recent work kept after a summary scales with the model', () => {
	assert.equal(keepTokensFor(undefined), 40_000);
	assert.equal(keepTokensFor(128_000), 40_000);
	assert.equal(keepTokensFor(1_000_000), 150_000);
	assert.equal(keepTokensFor(10_000), 4_000);
	assert.equal(compactLimit(1_000_000), 850_000);
});

test('large files are readable', async () => {
	const { root, ctx, clean } = workspace();
	try {
		fs.writeFileSync(path.join(root, 'big.txt'), Array.from({ length: 1500 }, (_, i) => `line ${i} ${'a'.repeat(100)}`).join('\n'));
		const out = await tool('read_file').run({ path: 'big.txt' }, ctx);
		assert.ok(!out.includes('omitted'));
		assert.match(out, /1500\tline 1499/);
	} finally { clean(); }
});

test('sessions persist and reject unsafe ids', async () => {
	const { root, clean } = workspace();
	try {
		const store = new SessionStore(root);
		const session = newSession();
		session.title = 'Hello';
		await store.save(session);
		assert.equal((await store.list())[0].title, 'Hello');
		assert.equal((await store.load(session.id))?.title, 'Hello');
		await assert.rejects(store.delete('../../etc/passwd'), /Invalid/);
	} finally { clean(); }
});
