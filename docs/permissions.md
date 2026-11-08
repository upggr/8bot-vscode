---
title: 8bot Permission Modes, Including Bypass Permissions
description: How Ask first, Accept edits, Plan only and Bypass permissions work in 8bot for VS Code, and how to use them safely.
---

[Home](./)

| Mode | Reads | File edits | Commands |
|---|---|---|---|
| Ask first (default) | Automatic | Ask | Ask |
| Accept edits | Automatic | Automatic | Ask |
| Plan only | Automatic | Blocked | Blocked |
| Bypass permissions | Automatic | Automatic | Automatic |

Change the mode with the selector below the sidebar input, or with **8bot: Set Permission Mode**.

## Always-protected paths

Outside Bypass mode, these need approval even when reads or edits are otherwise automatic:

- `.env` files, private keys, `.npmrc`, `.netrc`, and anything under `.ssh`, `.aws` or `.gnupg`
- Changes under `.git`, `.vscode`, `.husky` and `.devcontainer`, because those can run code

## Always Allow

**Always** lasts for the current chat. For commands it applies only to that exact command, so approving `git status` does not approve `git status; rm -rf .`.

## Bypass permissions

Bypass runs every action with no prompt, and file tools can reach outside the workspace.

Text in a file, dependency or command output could try to steer the agent, and in Bypass mode nothing would stop it. Use Bypass only in a sandbox or container, or in a project you can restore from version control.

8bot asks you to confirm the first time you enable it and shows it in red. The setting is user-level, so opening a repository cannot turn it on.
