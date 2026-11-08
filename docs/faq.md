---
title: 8bot for VS Code FAQ and Troubleshooting
description: Answers about using 8bot and the Pax8 8os gateway in VS Code, API keys, models, credits and common errors.
---

[Home](./)

## Questions

**Is there an official 8bot or 8os plugin for VS Code?**
At the time of writing, none is listed on the VS Code Marketplace or Open VSX. This extension is independent and is not affiliated with Pax8.

**Where do I get an 8os API key?**
From your provider, or from [BUY IT](https://buy-it.gr/8os).

**Does this control my deployed 8bot agents?**
No. It uses the 8os model endpoints. Agent deployments in 8os need a Pax8 login.

**Which endpoint does it use?**
OpenAI-compatible `/v1/chat/completions` at `https://api.8os.com`.

**Is my code sent anywhere?**
Your messages and any files the agent reads go to the gateway you configured, and from there to the selected model.

## Troubleshooting

**The gateway rejected your API key (401).**
Run **8bot: Enter Gateway and API Key** and check both values.

**This API key is disabled, or the account is suspended (403).**
Contact your provider.

**Your spending or usage limit has been reached.**
Ask your provider to raise it, or get more from [BUY IT](https://buy-it.gr/8os).

**8os models are not in the Chat model picker.**
Open **Manage Models** in the picker and enable **8os Agent Gateway**.

**8bot does not start in this folder.**
Trust the workspace. 8bot does not run in restricted mode.
