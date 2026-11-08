---
title: 8bot for VS Code Settings Reference
description: Every setting for 8bot for VS Code, including gateway URL, model, permission mode, reasoning effort and spend limit.
---

[Home](./)

| Setting | Default | Description |
|---|---|---|
| `eightbot.baseUrl` | `https://api.8os.com` | Gateway URL |
| `eightbot.defaultModel` | `auto` | Model used until you pick another |
| `eightbot.permissionMode` | `default` | Permission mode at startup |
| `eightbot.reasoningEffort` | empty | Used when the model supports it |
| `eightbot.maxTurns` | `200` | Model turns per request |
| `eightbot.maxOutputTokens` | `0` | Output limit per turn. 0 uses up to 32,000 tokens or the model's maximum |
| `eightbot.commandTimeoutSeconds` | `120` | Default command timeout |
| `eightbot.customInstructions` | empty | Added to every conversation |
| `eightbot.monthlySpendLimit` | `0` | Your own monthly limit in USD |
| `eightbot.pax8ClientId` | empty | Client account for live limits |
| `eightbot.taskHint` | empty | Sent as `X-Pax8-Task` for routing rules |
| `eightbot.agentId` | `8bot-vscode` | Sent as `X-Pax8-Agent-ID` |
| `eightbot.pax8McpServer` | `false` | Offer the Pax8 MCP server to VS Code Chat |

All of these are user-level settings, so a workspace cannot override them.

For local development, the `EIGHTOS_API_KEY` environment variable is used when no key is stored.
