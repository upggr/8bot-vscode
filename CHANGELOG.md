# Changelog

## 0.1.17

- A cleaner, calmer chat in the spirit of the Claude plugin: one rounded composer holds your message, attachments and the model picker, and the busy status now has a spinner. Tool calls and thinking collapse into quiet one-line pills instead of big boxes.
- Advanced options (permission mode, reasoning effort, API keys, credits and context) are tucked behind a single "Options" row; non-default choices show as small badges so the defaults stay out of the way.
- Fixed the "stuck" feeling: after a VS Code reload the panel re-loads its state as soon as it becomes visible instead of sitting empty, and a request that streams nothing for 90 seconds (configurable) now fails with a clear message and a Stop button instead of hanging for 10 minutes. The status line also says "Still waiting… press Stop" during long silences.

## 0.1.16

- Remember permission mode (including previously confirmed bypass) and the include-selection checkbox per workspace across window reloads. Model and reasoning effort continue to persist.
- Replace the plain model dropdown with a themed model card opening VS Code's searchable, keyboard-accessible picker, with the current model, context size and tool/reasoning details.

## 0.1.15

- The status bar no longer turns red in bypass mode; a chosen permission mode is not an error. It keeps the warning icon, and red is reserved for an empty limit.

## 0.1.14

- More accurate spend figures: the locally counted monthly spend is now tracked per API key, so switching keys no longer mixes spend from different accounts into one number. The live Pax8 limit is refreshed immediately when you switch keys, and it is shown in the currency the gateway reports (e.g. €) instead of always $.

## 0.1.13

- Long chats are summarized automatically as they near the gateway's size limit, so older context is condensed instead of left out. Models with very large context windows reach that limit long before their token limit.
- Every saved key can now be removed from the key icon, including the one in use. 8bot moves to another saved key, or back to setup if none is left.

## 0.1.12

- Fix "The gateway rejected your API key (401)" on long chats with a working key. The gateway answers 401 to any request over about 1 MB, so 8bot now keeps requests under that by leaving out old images first, then old tool output, then the oldest turns. The saved chat is not changed.
- Retries after a brief server error no longer fail with the same false 401, and a 401 now only blames your key if the gateway really rejects it.
- The API key control is now a small key icon next to the spend figure: green when the key works, red when it is rejected, grey until checked. Click it to switch, add or forget keys.

## 0.1.11

- Pick or add an API key right in the chat: a key button under the model picker shows which key is active, switches between saved keys, adds a new one and forgets old ones. Keys saved before 0.1.10 now appear there too, and the chat view only ever receives masked keys.
- Cleaner controls: reasoning effort and permission mode are now one-click toggles, and the remaining dropdowns have a tidier rounded style.

## 0.1.10

- Switch between saved API keys: **8bot: Switch API Key** lists every saved key with a friendly name, masked key and gateway, and switches or forgets them. The setup screen can name a key when you add it. Keys stay in VS Code secret storage.

## 0.1.9

- Export the chat as Markdown from the view menu or **8bot: Export Chat as Markdown**, with tool calls and results included.
- Every error now has a Retry button that re-sends the last message.
- Attached images show as inline thumbnails in the chat instead of only a file chip.
- New `/cost` command: per-model spend for the current chat, with cached and reasoning token shares.
- Dictate messages with the 🎤 button where speech recognition is available.
- The model parser keeps raw input/output modality lists, so audio or image models surface automatically if the gateway ever adds them.

## 0.1.8

- Live progress with numbers: the status line now shows streamed output as it arrives (~tokens out), the Thinking panel shows its own running token count, and once a request has reported its real cost, a rough live $ estimate appears while the model works.

## 0.1.7

- Deeper native VS Code Chat integration: the configured reasoning effort now applies to 8os models used by VS Code's own Chat agent mode, deprecated models are marked in VS Code's model picker, and token counting covers tool calls and images so context warnings are accurate.

## 0.1.6

- Message queue: type while 8bot is working and your message waits in a visible queue and runs next, instead of being lost. Queued messages can be removed, and Stop clears the queue.

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
