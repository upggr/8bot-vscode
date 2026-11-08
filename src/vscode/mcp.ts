import * as vscode from 'vscode';
import { Services } from './services';

const PAX8_MCP_URL = 'https://mcp.pax8.com/v1/mcp';

/** Offers Pax8's documented MCP server to VS Code Chat when the user opts in. VS Code handles its sign-in. */
export function registerPax8McpServer(services: Services): vscode.Disposable {
	const changed = new vscode.EventEmitter<void>();
	const listener = vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('eightbot.pax8McpServer')) { changed.fire(); }
	});
	const provider = vscode.lm.registerMcpServerDefinitionProvider('eightbot.pax8Mcp', {
		onDidChangeMcpServerDefinitions: changed.event,
		provideMcpServerDefinitions: () => services.config.get<boolean>('pax8McpServer', false)
			? [new vscode.McpHttpServerDefinition('Pax8', vscode.Uri.parse(PAX8_MCP_URL))]
			: [],
	});
	return vscode.Disposable.from(provider, listener, changed);
}
