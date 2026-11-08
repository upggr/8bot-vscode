<p align="center"><img src="media/icon.png" width="120" alt="8bot for VS Code logo"></p>

<h1 align="center">8bot for VS Code</h1>

<p align="center"><strong>An AI coding agent and chat for Visual Studio Code, powered by your 8os Agent Gateway and API key.</strong></p>

<p align="center">
  <a href="https://upggr.github.io/8bot-vscode/getting-started.html">Get started</a> ·
  <a href="https://upggr.github.io/8bot-vscode/">Documentation</a> ·
  <a href="https://buy-it.gr/8os">Get an 8os subscription</a> ·
  <a href="https://github.com/upggr/8bot-vscode/issues">Report an issue</a>
</p>

8bot for VS Code connects Visual Studio Code to the **Pax8 8os Agent Gateway**. Chat with your code, let an agent edit files and run terminal commands, choose any model your 8os key allows, and control exactly what the agent may do without leaving the editor.

It works in its own sidebar, as **`@8bot` in the VS Code Chat window**, and as a model provider that adds 8os models to the VS Code Chat model picker.

> **Unofficial.** 8bot for VS Code is an independent open source project. It is not affiliated with, endorsed by or supported by Pax8. 8os and 8bot are products of Pax8.

## Features

- **Sidebar chat** with streaming replies, saved history, slash commands and the current selection as context.
- **`@8bot` in VS Code Chat**, with `/plan`, `/edit`, `/bypass` and `/models`.
- **8os models in the VS Code model picker**, usable by VS Code's built-in Agent mode.
- **Coding agent tools:** read, list and search files, create and edit files, and run terminal commands.
- **Model selection** from your live gateway catalog, including `auto` routing and per-model reasoning effort.
- **Four permission modes:** Ask first, Accept edits, Plan only and Bypass permissions.
- **Diff preview** before you approve a file change.
- **Credits and spend** in the status bar and chat, with the exact gateway cost of every request.
- **Project instructions** from `AGENTS.md` or `8BOT.md`.
- **Automatic context summarizing** when a conversation gets long, or on demand with `/compact`.
- **Secure by default:** your key stays in VS Code secret storage and is removed from the environment of agent commands.

## Quick start

1. [Download the latest `.vsix`](https://github.com/upggr/8bot-vscode/releases/latest), then in VS Code open **Extensions**, select the **...** menu and choose **Install from VSIX**.
2. Open the **8bot** icon in the Activity Bar.
3. **Did your provider already give you a gateway and API key?** Enter them on the setup screen. The default gateway is `https://api.8os.com`.
4. **No gateway or key yet?** [Get an 8os subscription from BUY IT](https://buy-it.gr/8os).
5. Open a folder and ask 8bot to do something.

Full guide: [Getting started](https://upggr.github.io/8bot-vscode/getting-started.html).

## Three ways to use it

| Where | How | Best for |
|---|---|---|
| 8bot sidebar | Click the 8bot icon, or press `Cmd+Alt+8` (`Ctrl+Alt+8` on Windows and Linux) | Full agent with history, approvals and credits |
| VS Code Chat | Type `@8bot` in the Chat window | Working alongside other VS Code chat agents |
| Model picker | Add **8os Agent Gateway** in Manage Models | Using 8os models with VS Code's built-in agent |

## Permission modes

| Mode | Reads | File edits | Commands |
|---|---|---|---|
| **Ask first** (default) | Automatic | Ask | Ask |
| **Accept edits** | Automatic | Automatic | Ask |
| **Plan only** | Automatic | Blocked | Blocked |
| **Bypass permissions** | Automatic | Automatic | Automatic |

Secrets such as `.env` files and SSH keys always need approval, as do changes to `.git` and `.vscode`, except in Bypass mode.

**Bypass permissions removes every safeguard.** The agent can change any file and run any command, inside or outside the workspace, and text in a file or command output could try to steer it. Use it only in a sandbox or a project you can restore. VS Code asks you to confirm the first time, and a repository cannot turn it on. See [Permissions](https://upggr.github.io/8bot-vscode/permissions.html).

## Credits and limits

The gateway reports the cost of every request, but an 8os API key cannot read the account balance, so 8bot offers three levels:

1. **Always:** the exact cost the gateway reports for each request, totaled for the month on this computer.
2. **With `eightbot.monthlySpendLimit`:** what is left of a limit you choose.
3. **With a connected Pax8 access token:** your live spend limit and remaining balance from 8os.

Details: [Credits and limits](https://upggr.github.io/8bot-vscode/credits.html).

## Gateway features supported

Streaming chat completions, tool calling, the governed model catalog, `auto` routing, `X-Pax8-Task` routing rules, `X-Pax8-Agent-ID` and `X-Pax8-Feature` attribution, idempotent retries, guard flags, per-request cost, refusal and suspension codes, spend limits, and the Pax8 MCP server (optional).

## Install from source

Requires Node.js 22 or later and VS Code 1.145 or later.

```bash
git clone https://github.com/upggr/8bot-vscode.git
cd 8bot-vscode
npm install
npm run package
code --install-extension 8bot-vscode-*.vsix
```

## FAQ

**Is there an official 8bot or 8os extension for VS Code?** At the time of writing, none is listed on the VS Code Marketplace or Open VSX. This is an independent, open source extension.

**Does it need GitHub Copilot?** The sidebar works without it. VS Code's own Chat window features depend on what your VS Code installation has enabled.

**Where do I get an 8os API key?** From your provider, or from [BUY IT](https://buy-it.gr/8os).

**Which models can I use?** Whatever your key is allowed. 8bot reads the list live from your gateway.

More answers: [FAQ](https://upggr.github.io/8bot-vscode/faq.html).

## Development

```bash
npm test            # unit and webview tests
npm run lint
npm run test:e2e    # runs inside a real VS Code
npm run test:live   # uses a real key from .env and spends a small amount
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Author

Created and maintained by **Ioannis Kokkinis** ([GitHub](https://github.com/upggr), [BUY IT](https://buy-it.gr)).

## License

[MIT](LICENSE) © Ioannis Kokkinis

*Pax8, 8os and 8bot are the property of their respective owners and are used here only to describe compatibility.*
