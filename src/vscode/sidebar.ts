import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentEvent, compact, PermissionAnswer, PermissionRequest, runAgent } from '../core/agent';
import { BUY_URL } from '../core/credits';
import { GatewayClient, GatewayError } from '../core/gateway';
import { isPermissionMode, PERMISSION_MODES } from '../core/permissions';
import { buildSystemPrompt, loadProjectInstructions } from '../core/prompt';
import { newSession, Session, SessionStore } from '../core/sessions';
import { findTool } from '../core/tools';
import { ChatMessage } from '../core/types';
import { Services } from './services';

const DIFF_SCHEME = 'eightbot-diff';
const CONTEXT_OPEN = '\n\n<editor_context>';
const HELP = [
	'**Commands**',
	'- `/new` start a new chat',
	'- `/compact` summarize this chat to free context',
	'- `/model <id>` switch model',
	'- `/mode <default|acceptEdits|plan|bypassPermissions>` switch permission mode',
	'- `/credits` show spend and credits',
].join('\n');

interface WebviewMessage {
	type: string;
	text?: string;
	includeSelection?: boolean;
	id?: string;
	value?: string;
	answer?: PermissionAnswer;
	gateway?: string;
	key?: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
	static readonly viewId = 'eightbot.chatView';

	private view: vscode.WebviewView | undefined;
	private session: Session = newSession();
	private readonly store: SessionStore;
	private abort: AbortController | undefined;
	private remembered = new Set<string>();
	private readonly pending = new Map<string, { resolve: (answer: PermissionAnswer) => void; request: PermissionRequest }>();
	private readonly diffContent = new Map<string, string>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private lastPromptTokens = 0;

	constructor(private readonly context: vscode.ExtensionContext, private readonly services: Services) {
		const base = context.storageUri ?? context.globalStorageUri;
		this.store = new SessionStore(path.join(base.fsPath, 'sessions'));
		this.subscriptions.push(
			services.onDidChange(() => void this.postState()),
			services.onDidChangeModels(() => void this.postState()),
			vscode.window.onDidChangeTextEditorSelection(() => void this.postState()),
			vscode.window.onDidChangeActiveTextEditor(() => void this.postState()),
			vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this),
		);
	}

	dispose(): void {
		this.abort?.abort();
		vscode.Disposable.from(...this.subscriptions).dispose();
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.diffContent.get(uri.toString()) ?? '';
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);
		this.subscriptions.push(view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.onMessage(message)));
		view.onDidDispose(() => { this.view = undefined; });
	}

	async reveal(): Promise<void> {
		await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
	}

	async startNew(): Promise<void> {
		this.stop();
		this.session = newSession();
		this.remembered = new Set();
		this.lastPromptTokens = 0;
		await this.postTranscript();
		await this.postState();
	}

	async showSetup(): Promise<void> {
		await this.reveal();
		this.post({ type: 'showSetup' });
	}

	async askAboutSelection(): Promise<void> {
		await this.reveal();
		this.post({ type: 'focusInput', text: 'Explain the selected code.' });
	}

	private stop(): void {
		this.abort?.abort();
		for (const { resolve } of this.pending.values()) { resolve('deny'); }
		this.pending.clear();
	}

	private post(message: object): void {
		void this.view?.webview.postMessage(message);
	}

	private async onMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				await this.postState();
				await this.postTranscript();
				break;
			case 'send':
				if (message.text?.trim()) { await this.send(message.text.trim(), message.includeSelection === true); }
				break;
			case 'stop':
				this.stop();
				break;
			case 'newChat':
				await this.startNew();
				break;
			case 'loadSession':
				await this.loadSession(message.value ?? '');
				break;
			case 'setModel':
				if (message.value) { await this.services.setModel(message.value); }
				break;
			case 'setMode':
				if (isPermissionMode(message.value)) { await this.services.setMode(message.value); }
				break;
			case 'setEffort':
				await this.services.config.update('reasoningEffort', message.value ?? '', vscode.ConfigurationTarget.Global);
				break;
			case 'permission':
				this.answerPermission(message.id ?? '', message.answer ?? 'deny');
				break;
			case 'openDiff':
				await this.openDiff(message.id ?? '');
				break;
			case 'saveConnection':
				this.post({ type: 'setupResult', error: await this.services.saveConnection(message.gateway ?? '', message.key ?? '') });
				break;
			case 'buy':
				await this.services.openSubscriptionPage();
				break;
			case 'credits':
				await this.services.showCredits();
				break;
			default:
				break;
		}
	}

	private answerPermission(id: string, answer: PermissionAnswer): void {
		const entry = this.pending.get(id);
		if (entry) {
			this.pending.delete(id);
			entry.resolve(answer);
		}
	}

	private async openDiff(id: string): Promise<void> {
		const preview = this.pending.get(id)?.request.preview;
		if (!preview) { return; }
		const nonce = randomBytes(4).toString('hex');
		const left = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/before/${nonce}/${path.basename(preview.path)}` });
		const right = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/after/${nonce}/${path.basename(preview.path)}` });
		this.diffContent.set(left.toString(), preview.before);
		this.diffContent.set(right.toString(), preview.after);
		await vscode.commands.executeCommand('vscode.diff', left, right, `Proposed change: ${path.basename(preview.path)}`, { preview: true });
	}

	private async loadSession(id: string): Promise<void> {
		if (this.abort) { return; }
		const session = await this.store.load(id);
		if (session) {
			this.session = session;
			this.remembered = new Set();
			this.lastPromptTokens = 0;
			await this.postTranscript();
			await this.postState();
		}
	}

	private editorContext(): { file: string; lines: string; text: string } | undefined {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) { return undefined; }
		const { start, end } = editor.selection;
		return {
			file: vscode.workspace.asRelativePath(editor.document.uri),
			lines: start.line === end.line ? `${start.line + 1}` : `${start.line + 1}-${end.line + 1}`,
			text: editor.document.getText(editor.selection),
		};
	}

	private async postState(): Promise<void> {
		if (!this.view) { return; }
		const models = this.services.hasKey ? await this.services.models().catch(() => []) : [];
		const selection = this.editorContext();
		this.post({
			type: 'state',
			hasKey: this.services.hasKey,
			gateway: this.services.baseUrl,
			buyUrl: BUY_URL,
			models: models.map(m => ({ id: m.id, name: m.name, efforts: m.reasoningEfforts, contextWindow: m.contextWindow })),
			model: this.services.model,
			mode: this.services.mode,
			modes: PERMISSION_MODES,
			effort: this.services.config.get<string>('reasoningEffort', ''),
			sessions: await this.store.list(),
			sessionId: this.session.id,
			busy: this.abort !== undefined,
			credits: this.services.credits,
			promptTokens: this.lastPromptTokens,
			selection: selection ? { file: selection.file, lines: selection.lines } : undefined,
		});
	}

	private async postTranscript(): Promise<void> {
		this.post({ type: 'transcript', items: transcriptItems(this.session.messages) });
	}

	private async send(text: string, includeSelection: boolean): Promise<void> {
		if (this.abort) { return; }
		if (text.startsWith('/') && await this.slashCommand(text)) { return; }

		const client = await this.services.client('sidebar');
		if (!client) { return; }
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			this.post({ type: 'event', event: { type: 'error', message: 'Open a folder first so 8bot has a workspace to work in.' } });
			return;
		}

		const selection = includeSelection ? this.editorContext() : undefined;
		const content = selection ? `${text}${CONTEXT_OPEN}\nSelected from ${selection.file}:${selection.lines}\n${selection.text}\n</editor_context>` : text;
		this.session.messages.push({ role: 'user', content });
		if (this.session.title === 'New chat') { this.session.title = text.slice(0, 60); }
		this.post({ type: 'event', event: { type: 'user', text } });

		const abort = new AbortController();
		this.abort = abort;
		await this.postState();
		await this.run(client, root, abort);
	}

	private async run(client: GatewayClient, root: string, abort: AbortController): Promise<void> {
		const services = this.services;
		const model = services.model;
		const info = await services.modelInfo(model);
		const effort = services.config.get<string>('reasoningEffort', '');
		try {
			await runAgent({
				client,
				model,
				messages: this.session.messages,
				root,
				systemPrompt: await this.systemPrompt(root),
				commandTimeoutSeconds: services.config.get<number>('commandTimeoutSeconds', 120),
				maxTurns: services.config.get<number>('maxTurns', 50),
				maxTokens: services.config.get<number>('maxOutputTokens') || undefined,
				reasoningEffort: effort && info?.reasoningEfforts.includes(effort) ? effort : undefined,
				contextWindow: info?.contextWindow,
				supportsTools: info?.supportsTools,
				getMode: () => services.mode,
				requestPermission: request => this.requestPermission(request, abort.signal),
				onEvent: event => this.onAgentEvent(event),
				remembered: this.remembered,
				signal: abort.signal,
			});
		} catch (error) {
			const limitOrKey = error instanceof GatewayError && (error.limitReached || error.status === 401);
			this.post({ type: 'event', event: { type: 'error', message: (error as Error).message, showBuy: limitOrKey } });
		} finally {
			this.abort = undefined;
			this.session.updatedAt = Date.now();
			await this.store.save(this.session).catch(() => undefined);
			this.post({ type: 'event', event: { type: 'done' } });
			await this.postState();
		}
	}

	private async systemPrompt(root: string): Promise<string> {
		return buildSystemPrompt({
			root,
			mode: this.services.mode,
			projectInstructions: await loadProjectInstructions(root),
			customInstructions: this.services.config.get<string>('customInstructions'),
		});
	}

	private onAgentEvent(event: AgentEvent): void {
		if (event.type === 'usage') { this.lastPromptTokens = event.usage.promptTokens; }
		this.post({ type: 'event', event });
	}

	private requestPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
		if (signal.aborted) { return Promise.resolve('deny'); }
		return new Promise(resolve => {
			this.pending.set(request.callId, { resolve, request });
			this.post({
				type: 'event',
				event: {
					type: 'permission',
					callId: request.callId,
					summary: request.summary,
					detail: request.tool === 'run_command' ? String(request.args.command) : undefined,
					sensitive: request.kind === 'sensitiveRead' || request.kind === 'sensitiveEdit',
					canDiff: request.preview !== undefined,
				},
			});
		});
	}

	private async slashCommand(text: string): Promise<boolean> {
		const [command, ...rest] = text.split(/\s+/);
		const value = rest.join(' ');
		switch (command) {
			case '/new':
			case '/clear':
				await this.startNew();
				return true;
			case '/help':
				this.post({ type: 'event', event: { type: 'info', text: HELP } });
				return true;
			case '/model':
				if (value) { await this.services.setModel(value); } else { await this.services.pickModel(); }
				return true;
			case '/mode':
				if (isPermissionMode(value)) { await this.services.setMode(value); } else { await this.services.pickMode(); }
				return true;
			case '/credits':
				this.post({ type: 'event', event: { type: 'info', text: `**${this.services.credits.label}**\n\n${this.services.credits.detail}` } });
				return true;
			case '/compact':
				await this.compactSession();
				return true;
			default:
				return false;
		}
	}

	private async compactSession(): Promise<void> {
		const client = await this.services.client('sidebar');
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!client || !root || this.session.messages.length === 0) { return; }
		const abort = new AbortController();
		this.abort = abort;
		await this.postState();
		try {
			await compact({ client, model: this.services.model, systemPrompt: await this.systemPrompt(root), messages: this.session.messages, signal: abort.signal });
			this.lastPromptTokens = 0;
			await this.store.save(this.session);
			await this.postTranscript();
		} catch (error) {
			this.post({ type: 'event', event: { type: 'error', message: (error as Error).message } });
		} finally {
			this.abort = undefined;
			await this.postState();
		}
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = randomBytes(16).toString('base64');
		const uri = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('chat.css')}">
<title>8bot</title>
</head>
<body>
<section id="welcome" hidden>
	<h2>Connect 8bot</h2>
	<p><strong>Did your provider already give you a gateway and API key?</strong> Enter them here.</p>
	<label for="gateway">Gateway URL</label>
	<input id="gateway" type="url" spellcheck="false" autocomplete="off">
	<label for="apiKey">API key</label>
	<input id="apiKey" type="password" spellcheck="false" autocomplete="off" placeholder="sk-pax8-...">
	<p id="setupError" class="error-text" role="alert" hidden></p>
	<button id="saveConnection" type="button">Connect</button>
	<hr>
	<p><strong>No gateway or key yet?</strong> Buy an 8os subscription from BUY IT and we will set you up.</p>
	<button id="getSubscription" class="secondary" type="button">Get a subscription from BUY IT</button>
	<button id="closeSetup" class="link" type="button" hidden>Back to chat</button>
	<p class="muted">Your key is stored in VS Code secret storage. 8bot is an independent project, not affiliated with or endorsed by Pax8.</p>
</section>
<main id="app" hidden>
	<header>
		<select id="sessions" aria-label="Chat history"></select>
		<button id="newChat" class="icon" type="button" title="New chat" aria-label="New chat">+</button>
	</header>
	<div id="transcript" role="log" aria-live="polite"></div>
	<footer>
		<label id="selectionChip" hidden><input id="includeSelection" type="checkbox" checked> <span id="selectionText"></span></label>
		<textarea id="input" rows="3" placeholder="Ask 8bot to build, fix or explain. Type / for commands." aria-label="Message"></textarea>
		<div class="row">
			<select id="model" aria-label="Model" title="Model"></select>
			<select id="effort" aria-label="Reasoning effort" title="Reasoning effort" hidden></select>
			<select id="mode" aria-label="Permission mode" title="Permission mode"></select>
			<button id="send" type="button">Send</button>
			<button id="stop" class="secondary" type="button" hidden>Stop</button>
		</div>
		<div class="row meta">
			<button id="credits" class="link" type="button"></button>
			<span id="contextUsage"></span>
		</div>
	</footer>
</main>
<script nonce="${nonce}" src="${uri('markdown.js')}"></script>
<script nonce="${nonce}" src="${uri('chat.js')}"></script>
</body>
</html>`;
	}
}

function visibleUserText(content: ChatMessage['content']): string {
	const text = typeof content === 'string' ? content : '';
	const index = text.indexOf(CONTEXT_OPEN);
	return index >= 0 ? text.slice(0, index) : text;
}

/** Turns stored messages into items the webview can draw. */
export function transcriptItems(messages: ChatMessage[]): object[] {
	const results = new Map(messages.filter(m => m.role === 'tool').map(m => [m.tool_call_id, String(m.content ?? '')]));
	const items: object[] = [];
	for (const message of messages) {
		if (message.role === 'user') {
			items.push({ kind: 'user', text: visibleUserText(message.content) });
		} else if (message.role === 'assistant') {
			if (typeof message.content === 'string' && message.content) { items.push({ kind: 'assistant', text: message.content }); }
			for (const call of message.tool_calls ?? []) {
				let summary = call.function.name;
				try {
					summary = findTool(call.function.name)?.summary(JSON.parse(call.function.arguments) as Record<string, unknown>) ?? summary;
				} catch { /* keep the tool name */ }
				const output = results.get(call.id) ?? '';
				items.push({ kind: 'tool', summary, output, ok: !output.startsWith('Error:') });
			}
		}
	}
	return items;
}
