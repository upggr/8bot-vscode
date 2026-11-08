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

[Install 8bot from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=IoannisKokkinis.8bot-vscode), or search for **8bot** in the VS Code Extensions view.

You can also [download the `.vsix`](https://github.com/upggr/8bot-vscode/releases/latest) and use **Install from VSIX** in the Extensions view.

## Connect your gateway and key

Open the **8bot** tab in the Secondary Side Bar on the right, next to Chat. Press `Cmd+Alt+8` (`Ctrl+Alt+8` on Windows and Linux) to jump to it.

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
| `/remember <note>` | Save a fact for future chats |
| `/forget <text>` | Remove saved notes |
| `/memory` | Open saved memory |
| `/help` | List commands |

## Memory and long tasks

8bot remembers lasting facts about each project across chats. It can save them itself when you approve, or you can use `/remember <note>`, `/forget <text>` and `/memory`. Notes are stored privately on your computer, outside the repository. Your latest chat also comes back when you reopen VS Code.

Large models keep most of their context window available. When a conversation gets very long, 8bot summarizes the oldest part and keeps recent work in full.

## Project instructions

Put project rules in `AGENTS.md` or `8BOT.md` at the workspace root. 8bot includes them in every conversation.
