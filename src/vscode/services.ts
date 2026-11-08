import * as path from 'node:path';
import * as vscode from 'vscode';
import { addSpend, BUY_URL, creditStatus, CreditStatus, SpendRecord } from '../core/credits';
import { DEFAULT_BASE_URL, GatewayClient, GatewayError, LiveLimit, normalizeBaseUrl } from '../core/gateway';
import { addMemory, readMemory } from '../core/memory';
import { isPermissionMode, PERMISSION_MODES, PermissionMode } from '../core/permissions';
import { ModelInfo } from '../core/types';

const API_KEY_SECRET = 'eightbot.apiKey';
const PAX8_TOKEN_SECRET = 'eightbot.pax8Token';
const MODEL_STATE = 'eightbot.model';
const SPEND_STATE = 'eightbot.spend';
const BYPASS_ACK_STATE = 'eightbot.bypassAcknowledged';

export type Surface = 'sidebar' | 'chat-participant' | 'model-provider';

/** Shared state for the sidebar, the @8bot participant and the model provider. */
export class Services implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly modelsChanged = new vscode.EventEmitter<void>();
	readonly onDidChangeModels = this.modelsChanged.event;
	private readonly status: vscode.StatusBarItem;
	private readonly subscriptions: vscode.Disposable[] = [];
	private cachedModels: ModelInfo[] | undefined;
	private currentMode: PermissionMode;
	private liveLimit: LiveLimit | undefined;
	private keyPresent = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		const configured = this.config.get<string>('permissionMode');
		const startMode = isPermissionMode(configured) ? configured : 'default';
		// A setting alone cannot enable bypass until the user has accepted the warning once.
		this.currentMode = startMode === 'bypassPermissions' && !context.globalState.get(BYPASS_ACK_STATE) ? 'default' : startMode;
		this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.status.command = 'eightbot.openChat';
		this.subscriptions.push(
			this.changed,
			this.modelsChanged,
			this.status,
			context.secrets.onDidChange(e => {
				if (e.key === API_KEY_SECRET) { void this.keyChanged(); }
				if (e.key === PAX8_TOKEN_SECRET) { void this.refreshLiveCredits(); }
			}),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('eightbot')) {
					this.fire();
					if (e.affectsConfiguration('eightbot.baseUrl')) { void this.keyChanged(); }
					if (e.affectsConfiguration('eightbot.pax8ClientId')) { void this.refreshLiveCredits(); }
				}
			}),
		);
		void this.keyChanged();
	}

	dispose(): void {
		vscode.Disposable.from(...this.subscriptions).dispose();
	}

	get config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration('eightbot');
	}

	/** Private to this project, and outside the repository so it is never committed. */
	get memoryFile(): string {
		return path.join((this.context.storageUri ?? this.context.globalStorageUri).fsPath, 'memory.md');
	}

	async openMemory(): Promise<void> {
		if (!await readMemory(this.memoryFile)) {
			await addMemory(this.memoryFile, 'Add lasting project notes here, one per line.');
		}
		await vscode.window.showTextDocument(vscode.Uri.file(this.memoryFile));
	}

	get hasKey(): boolean {
		return this.keyPresent;
	}

	get mode(): PermissionMode {
		return this.currentMode;
	}

	get model(): string {
		return this.context.globalState.get<string>(MODEL_STATE) ?? this.config.get<string>('defaultModel', 'auto');
	}

	get credits(): CreditStatus {
		return creditStatus(this.context.globalState.get<SpendRecord>(SPEND_STATE), this.config.get<number>('monthlySpendLimit', 0), this.liveLimit);
	}

	async getApiKey(): Promise<string | undefined> {
		return (await this.context.secrets.get(API_KEY_SECRET)) || process.env.EIGHTOS_API_KEY || undefined;
	}

	/** Returns a client, or undefined after telling a user with no key where to get one. */
	async client(feature: Surface): Promise<GatewayClient | undefined> {
		const apiKey = await this.getApiKey();
		if (!apiKey) {
			void this.promptForKey();
			return undefined;
		}
		return this.buildClient(apiKey, feature);
	}

	private buildClient(apiKey: string, feature: Surface, baseUrl = this.baseUrl): GatewayClient {
		return new GatewayClient({
			baseUrl,
			apiKey,
			taskHint: this.config.get<string>('taskHint') || undefined,
			agentId: this.config.get<string>('agentId') || undefined,
			feature,
			onUsage: usage => { if (usage.cost) { void this.recordCost(usage.cost); } },
		});
	}

	async promptForKey(): Promise<void> {
		const enter = 'Enter Gateway and Key';
		const buy = 'Get a Subscription';
		const choice = await vscode.window.showInformationMessage('8bot needs an 8os gateway and API key. Did your provider already give you one? Enter it, or get a subscription from BUY IT.', enter, buy);
		if (choice === enter) { await vscode.commands.executeCommand('eightbot.setApiKey'); }
		if (choice === buy) { await this.openSubscriptionPage(); }
	}

	async openSubscriptionPage(): Promise<void> {
		await vscode.env.openExternal(vscode.Uri.parse(BUY_URL));
	}

	get baseUrl(): string {
		return this.config.get<string>('baseUrl', DEFAULT_BASE_URL);
	}

	/** Validates and stores a gateway and key. Returns an error message, or undefined on success. */
	async saveConnection(gateway: string, key: string): Promise<string | undefined> {
		try {
			const baseUrl = normalizeBaseUrl(gateway || DEFAULT_BASE_URL);
			if (!key.trim()) { return 'Enter your API key.'; }
			await this.buildClient(key.trim(), 'sidebar', baseUrl).listModels();
			if (baseUrl !== normalizeBaseUrl(this.baseUrl)) {
				await this.config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
			}
			await this.context.secrets.store(API_KEY_SECRET, key.trim());
			return undefined;
		} catch (error) {
			return (error as Error).message;
		}
	}

	async clearApiKey(): Promise<void> {
		await this.context.secrets.delete(API_KEY_SECRET);
	}

	async connectPax8(): Promise<void> {
		const token = await vscode.window.showInputBox({
			title: 'Pax8 Access Token',
			prompt: 'Optional. A Pax8 access token lets 8bot read your live spend limit. An sk-pax8 key cannot.',
			password: true,
			ignoreFocusOut: true,
		});
		if (!token) { return; }
		const clientId = await vscode.window.showInputBox({
			title: 'Pax8 Client Account ID',
			value: this.config.get<string>('pax8ClientId', ''),
			ignoreFocusOut: true,
		});
		if (!clientId) { return; }
		await this.config.update('pax8ClientId', clientId.trim(), vscode.ConfigurationTarget.Global);
		await this.context.secrets.store(PAX8_TOKEN_SECRET, token.trim());
	}

	async refreshLiveCredits(): Promise<void> {
		const token = await this.context.secrets.get(PAX8_TOKEN_SECRET);
		const clientId = this.config.get<string>('pax8ClientId', '');
		const apiKey = await this.getApiKey();
		if (!token || !clientId || !apiKey) {
			this.liveLimit = undefined;
			this.fire();
			return;
		}
		try {
			this.liveLimit = await this.buildClient(apiKey, 'sidebar').getLiveLimit(token, clientId);
		} catch (error) {
			this.liveLimit = undefined;
			if (error instanceof GatewayError && (error.status === 401 || error.status === 403)) {
				void vscode.window.showWarningMessage('8bot could not read live credits because the Pax8 token was rejected or has expired.', 'Reconnect')
					.then(choice => { if (choice) { void this.connectPax8(); } });
			}
		}
		this.fire();
	}

	async models(force = false): Promise<ModelInfo[]> {
		if (this.cachedModels && !force) { return this.cachedModels; }
		const apiKey = await this.getApiKey();
		if (!apiKey) { return []; }
		this.cachedModels = await this.buildClient(apiKey, 'sidebar').listModels();
		return this.cachedModels;
	}

	async modelInfo(id: string): Promise<ModelInfo | undefined> {
		return (await this.models().catch(() => [])).find(m => m.id === id);
	}

	async setModel(id: string): Promise<void> {
		await this.context.globalState.update(MODEL_STATE, id);
		this.fire();
	}

	async pickModel(): Promise<void> {
		if (!await this.client('sidebar')) { return; }
		const models = await this.models(true);
		const picked = await vscode.window.showQuickPick(
			models.map(m => ({ label: m.name, description: m.id, detail: m.description, picked: m.id === this.model, id: m.id })),
			{ title: 'Select Model', matchOnDescription: true },
		);
		if (picked) { await this.setModel(picked.id); }
	}

	/** Switches mode, showing the warning the first time bypass is turned on. Returns false if declined. */
	async setMode(mode: PermissionMode): Promise<boolean> {
		if (!await this.confirmBypass(mode)) {
			this.fire();
			return false;
		}
		this.currentMode = mode;
		this.fire();
		return true;
	}

	async confirmBypass(mode: PermissionMode): Promise<boolean> {
		if (mode !== 'bypassPermissions' || this.context.globalState.get(BYPASS_ACK_STATE)) { return true; }
		const enable = 'Enable Bypass';
		const choice = await vscode.window.showWarningMessage(
			'Bypass permissions lets the agent edit any file and run any command with no prompts, including outside this workspace. A malicious file or web page could steer it. Use it only in a sandbox or a project you can restore.',
			{ modal: true },
			enable,
		);
		if (choice !== enable) { return false; }
		await this.context.globalState.update(BYPASS_ACK_STATE, true);
		return true;
	}

	async pickMode(): Promise<void> {
		const picked = await vscode.window.showQuickPick(
			PERMISSION_MODES.map(m => ({ label: m.label, description: m.id === this.mode ? 'current' : undefined, detail: m.detail, id: m.id })),
			{ title: 'Permission Mode' },
		);
		if (picked) { await this.setMode(picked.id); }
	}

	async showCredits(): Promise<void> {
		const credits = this.credits;
		const buy = 'Get More';
		const connect = 'Connect Pax8 Account';
		const choice = await vscode.window.showInformationMessage(`${credits.label}. ${credits.detail}`, buy, ...(credits.live ? [] : [connect]));
		if (choice === buy) { await this.openSubscriptionPage(); }
		if (choice === connect) { await this.connectPax8(); }
	}

	private async recordCost(cost: number): Promise<void> {
		const before = this.credits.level;
		await this.context.globalState.update(SPEND_STATE, addSpend(this.context.globalState.get<SpendRecord>(SPEND_STATE), cost));
		this.fire();
		const after = this.credits;
		if (after.level !== before && after.level !== 'ok') {
			const buy = 'Get More';
			void vscode.window.showWarningMessage(`8bot credits: ${after.label}. ${after.detail}`, buy)
				.then(choice => { if (choice) { void this.openSubscriptionPage(); } });
		}
	}

	private async keyChanged(): Promise<void> {
		this.keyPresent = !!(await this.getApiKey());
		this.cachedModels = undefined;
		this.modelsChanged.fire();
		await this.refreshLiveCredits();
		this.fire();
	}

	private fire(): void {
		this.renderStatus();
		this.changed.fire();
	}

	private renderStatus(): void {
		const bypass = this.currentMode === 'bypassPermissions';
		if (!this.keyPresent) {
			this.status.text = '$(key) 8bot: add API key';
			this.status.command = 'eightbot.setApiKey';
			this.status.backgroundColor = undefined;
			this.status.tooltip = 'Enter your 8os API key, or get a subscription from BUY IT';
		} else {
			const credits = this.credits;
			this.status.text = `${bypass ? '$(warning)' : '$(sparkle)'} 8bot ${credits.label}`;
			this.status.command = 'eightbot.showCredits';
			this.status.backgroundColor = bypass || credits.level === 'empty'
				? new vscode.ThemeColor('statusBarItem.errorBackground')
				: credits.level === 'low' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
			this.status.tooltip = `${this.model} · ${this.currentMode}\n${credits.detail}`;
		}
		this.status.show();
	}
}
