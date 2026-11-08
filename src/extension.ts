import * as vscode from 'vscode';
import { GatewayModelProvider, VENDOR } from './vscode/lmProvider';
import { registerPax8McpServer } from './vscode/mcp';
import { registerParticipant } from './vscode/participant';
import { Services } from './vscode/services';
import { ChatViewProvider } from './vscode/sidebar';

export function activate(context: vscode.ExtensionContext): void {
	const services = new Services(context);
	const chatView = new ChatViewProvider(context, services);

	context.subscriptions.push(
		services,
		chatView,
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatView, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.lm.registerLanguageModelChatProvider(VENDOR, new GatewayModelProvider(services)),
		registerParticipant(context, services),
		registerPax8McpServer(services),
		vscode.commands.registerCommand('eightbot.openChat', () => chatView.reveal()),
		vscode.commands.registerCommand('eightbot.newChat', () => chatView.startNew()),
		vscode.commands.registerCommand('eightbot.setApiKey', () => chatView.showSetup()),
		vscode.commands.registerCommand('eightbot.clearApiKey', () => services.clearApiKey()),
		vscode.commands.registerCommand('eightbot.switchApiKey', () => services.pickApiKey()),
		vscode.commands.registerCommand('eightbot.selectModel', () => services.pickModel()),
		vscode.commands.registerCommand('eightbot.setPermissionMode', () => services.pickMode()),
		vscode.commands.registerCommand('eightbot.askAboutSelection', () => chatView.askAboutSelection()),
		vscode.commands.registerCommand('eightbot.getSubscription', () => services.openSubscriptionPage()),
		vscode.commands.registerCommand('eightbot.connectPax8', () => services.connectPax8()),
		vscode.commands.registerCommand('eightbot.showCredits', () => services.showCredits()),
		vscode.commands.registerCommand('eightbot.openMemory', () => services.openMemory()),
		vscode.commands.registerCommand('eightbot.exportChat', () => chatView.exportChat()),
	);
}

export function deactivate(): void {
	// Everything is released through context.subscriptions.
}
