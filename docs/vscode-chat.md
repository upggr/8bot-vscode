---
title: Use 8os Models in the VS Code Chat Window
description: Use @8bot in the VS Code Chat window and add Pax8 8os gateway models to the VS Code Chat model picker and Agent mode.
---

[Home](./)

8bot joins the VS Code Chat window in two ways.

## @8bot

Type `@8bot` followed by your request. Attach files with VS Code's usual context options.

| Command | What it does |
|---|---|
| `/plan` | Read and plan only |
| `/edit` | Apply edits automatically and ask before commands |
| `/bypass` | Run this request with no prompts |
| `/models` | List the models your key can use |

If an 8os model is selected in the picker, `@8bot` uses it. Otherwise it uses the model chosen in the 8bot sidebar.

## 8os models in the model picker

Open the model picker in Chat, select **Manage Models**, and enable **8os Agent Gateway**. The models then work with VS Code's built-in chat modes, including Agent mode when the model supports tools.

## Agent session list

VS Code's agent session list is still a proposed API that published extensions cannot use, so 8bot does not appear there yet.

## Pax8 MCP server

Turn on `eightbot.pax8McpServer` to offer the [Pax8 MCP server](https://devx.pax8.com/docs/mcp-server) to VS Code Chat. VS Code handles its sign-in.
