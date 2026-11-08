---
title: Getting Started with 8bot for VS Code
description: Install 8bot for VS Code and connect your 8os gateway and API key, or get a subscription, in a few minutes.
---

[Home](./)

## Requirements

- Visual Studio Code 1.145 or later
- An 8os gateway and API key
- A trusted workspace, because 8bot can edit files and run commands

## Install

Build the extension from source until a Marketplace release is available:

```bash
git clone https://github.com/upggr/8bot-vscode.git
cd 8bot-vscode
npm install
npm run package
code --install-extension 8bot-vscode-*.vsix
```

## Connect your gateway and key

Open the **8bot** icon in the Activity Bar.

**Did your provider already give you a gateway and API key?** Enter them on the setup screen and select **Connect**. The default gateway is `https://api.8os.com`, and 8os keys start with `sk-pax8-`. 8bot checks the connection before saving, and your key goes into VS Code secret storage.

**No gateway or key yet?** Select **Get a subscription from BUY IT**, or go to [buy-it.gr/8os](https://buy-it.gr/8os).

To change them later, run **8bot: Enter Gateway and API Key** from the Command Palette.

## First request

Open a folder, type a request such as `Add tests for the date helpers` and press Enter. By default, 8bot asks before each edit or command.

## Slash commands in the sidebar

| Command | What it does |
|---|---|
| `/new` | Start a new chat |
| `/compact` | Summarize the chat to free context |
| `/model <id>` | Switch model |
| `/mode <mode>` | Switch permission mode |
| `/credits` | Show spend and credits |
| `/help` | List commands |

## Project instructions

Put project rules in `AGENTS.md` or `8BOT.md` at the workspace root. 8bot includes them in every conversation.
