---
title: Credits, Spend and Limits in 8bot for VS Code
description: See 8os gateway request costs, monthly spend and remaining credits in VS Code with 8bot.
---

[Home](./)

8bot shows credits in the status bar and below the chat input.

## What an API key can see

An `sk-pax8` key can use the model endpoints but cannot read the account balance. The usage and limit endpoints need a Pax8 access token. 8bot therefore has three levels.

### 1. Monthly spend (always on)

The gateway reports the cost of each request, and 8bot adds those up for the month. This counts requests made from this computer only.

### 2. Your own limit

Set `eightbot.monthlySpendLimit` to a dollar amount and 8bot shows what is left. 8bot warns you when it is nearly used, but only the gateway can enforce a limit.

### 3. Live limit from Pax8

Run **8bot: Connect Pax8 Account for Live Credits**, then enter a Pax8 access token and your client account ID. 8bot reads your spending limit, usage and remaining amount from 8os. The token is kept in VS Code secret storage.

## When a limit is reached

The gateway refuses further requests. 8bot explains why and links to [buy-it.gr/8os](https://buy-it.gr/8os).
