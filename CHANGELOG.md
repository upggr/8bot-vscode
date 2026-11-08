# Changelog

## 0.1.5

- Attach files, images and screenshots to the sidebar chat by dragging, pasting or picking them.
- Fix empty replies repeating forever on the `auto` model: a reply cut off with no text now gets real output room on retry instead of only on models with an explicit limit.
- Send images on `auto` routing and known vision-capable models; the gateway catalog wrongly marks every model as text-only.
- Show richer per-request usage on the context meter: reasoning tokens, tokens written to the prompt cache, and exact request cost.
- Flag deprecated models in the model picker, from the gateway's deprecation info.
- New `eightbot.planModel` setting: use a different (for example cheaper) model automatically while in plan mode.

## 0.1.4

- Give models enough output room, which fixes empty replies on long chats.
- Show live progress while a model is thinking.
- Report a stream that stops responding instead of waiting forever.

## 0.1.3

- Retry automatically when a model returns an empty reply.

## 0.1.2

- Move 8bot to a tab in the right sidebar, next to Chat.

## 0.1.1

- When automatic routing is rejected by the model provider, retry on an available DeepSeek model.
- Send less repeated context: drop superseded file reads and shorten old tool output.
- Summarize older messages while keeping recent work, and keep the full chat visible.
- Recover from oversized requests by summarizing and retrying once.
- Use prompt caching, and show cached tokens on the context meter.
- Add project memory across chats with `/remember`, `/forget` and `/memory`.
- Restore the latest chat when VS Code reopens.
- Allow larger file reads and longer agent runs.

## 0.1.0

First release.

- Sidebar chat with streaming, history, slash commands and diff previews.
- `@8bot` in the VS Code Chat window.
- 8os models in the VS Code Chat model picker.
- File, search and terminal tools with four permission modes, including Bypass.
- Live model catalog, `auto` routing and per-model reasoning effort.
- Credits: per-request cost, a personal monthly limit, and live Pax8 limits.
- Support for gateway routing, attribution, idempotent retries, guard flags and refusal codes.
- Optional Pax8 MCP server.
