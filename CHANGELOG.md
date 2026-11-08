# Changelog

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
