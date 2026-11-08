import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const media = path.join(__dirname, '..', '..', 'media');
const { render } = require(path.join(media, 'markdown.js')) as { render(text: string): string };

const BODY = `
<section id="welcome" hidden><input id="gateway"><input id="apiKey"><p id="setupError" hidden></p><button id="saveConnection"></button><button id="getSubscription"></button><button id="closeSetup" hidden></button></section>
<main id="app" hidden>
<select id="sessions"></select><button id="newChat"></button><div id="transcript"></div>
<label id="selectionChip" hidden><input id="includeSelection" type="checkbox" checked><span id="selectionText"></span></label>
<div id="status" hidden></div><div id="queue" hidden></div><div id="attachments" hidden></div><textarea id="input"></textarea><input id="fileInput" type="file" hidden>
<button id="attach"></button><select id="model"></select><select id="effort" hidden></select><select id="mode"></select>
<button id="send"></button><button id="stop" hidden></button><button id="credits"></button><span id="contextUsage"></span>
</main>`;

const STATE = {
	type: 'state', hasKey: true, buyUrl: 'x', gateway: 'https://api.8os.com',
	models: [{ id: 'a', name: 'A', efforts: ['low', 'high'], contextWindow: 100 }, { id: 'b', name: 'B', efforts: [], contextWindow: 100 }],
	model: 'a', mode: 'default', effort: 'high',
	modes: [{ id: 'default', label: 'Ask first', detail: '' }, { id: 'bypassPermissions', label: 'Bypass', detail: '' }],
	sessions: [], sessionId: 's1', busy: false, credits: { label: '$1.00 left', detail: 'd', level: 'low', live: false }, promptTokens: 50,
};

function load() {
	const dom = new JSDOM(`<!DOCTYPE html><body>${BODY}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
	const posted: { type: string; [key: string]: unknown }[] = [];
	const win = dom.window as unknown as { acquireVsCodeApi: () => unknown; eval(code: string): unknown; postMessage: unknown; document: Document; requestAnimationFrame(cb: () => void): number };
	win.acquireVsCodeApi = () => ({ postMessage: (m: { type: string }) => posted.push(JSON.parse(JSON.stringify(m))) });
	win.eval(fs.readFileSync(path.join(media, 'markdown.js'), 'utf8'));
	win.eval(fs.readFileSync(path.join(media, 'chat.js'), 'utf8'));
	const send = (data: object) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
	const $ = (id: string) => win.document.getElementById(id) as HTMLElement & { value: string; hidden: boolean };
	return { dom, posted, send, $, win };
}

test('markdown escapes HTML and blocks unsafe links', () => {
	const html = render('<img src=x onerror=alert(1)> [a](javascript:alert(1)) `<b>` **x**');
	assert.ok(!html.includes('<img'));
	assert.ok(!html.includes('href="javascript'));
	assert.ok(html.includes('<code>&lt;b&gt;</code>'));
	assert.ok(html.includes('<strong>x</strong>'));
	assert.ok(!render('```\n<script>alert(1)</script>\n```').includes('<script'));
	assert.ok(!render('[x](https://a.b/"onmouseover="alert(1))').includes('" onmouseover'));
});

test('markdown handles lists, tables and an unfinished code fence while streaming', () => {
	assert.ok(render('- a\n- b').includes('<ul><li>a</li><li>b</li></ul>'));
	assert.ok(render('| a |\n|---|\n| b |').includes('<td>b</td>'));
	assert.ok(render('```js\nlet a').includes('let a'));
});

test('a user with no key sees the welcome screen and can reach the subscription page', () => {
	const { posted, send, $ } = load();
	assert.equal(posted[0].type, 'ready');
	send({ ...STATE, hasKey: false });
	assert.equal($('welcome').hidden, false);
	assert.equal($('app').hidden, true);
	$('getSubscription').click();
	assert.equal(posted.at(-1)?.type, 'buy');
	assert.equal($('gateway').value, 'https://api.8os.com');
	$('apiKey').value = 'sk-pax8-abc';
	$('saveConnection').click();
	assert.deepEqual(posted.at(-1), { type: 'saveConnection', gateway: 'https://api.8os.com', key: 'sk-pax8-abc' });
	send({ type: 'setupResult', error: 'rejected' });
	assert.equal($('setupError').textContent, 'rejected');
	assert.equal($('setupError').hidden, false);
	send({ type: 'setupResult' });
	assert.equal($('apiKey').value, '');
	assert.equal($('setupError').hidden, true);
});

test('state fills pickers, per-model effort, credits and context use', () => {
	const { send, $ } = load();
	send(STATE);
	assert.equal($('app').hidden, false);
	assert.equal($('model').value, 'a');
	assert.equal($('effort').hidden, false);
	assert.equal($('effort').value, 'high');
	assert.equal($('credits').textContent, '$1.00 left');
	assert.ok($('credits').className.includes('low'));
	assert.equal($('contextUsage').textContent, '50% context');
	send({ ...STATE, model: 'b', mode: 'bypassPermissions' });
	assert.equal($('effort').hidden, true);
	assert.ok($('mode').className.includes('danger'));
});

test('sending, model changes and Enter post the right messages', () => {
	const { dom, posted, send, $ } = load();
	send(STATE);
	$('input').value = 'hello';
	$('input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.deepEqual(posted.at(-1), { type: 'send', text: 'hello', includeSelection: false, attachments: [] });
	assert.equal($('input').value, '');
	$('model').value = 'b';
	$('model').dispatchEvent(new dom.window.Event('change'));
	assert.deepEqual(posted.at(-1), { type: 'setModel', value: 'b' });
});

test('permission card answers once and tool output is plain text', () => {
	const { posted, send, $, win } = load();
	send(STATE);
	send({ type: 'event', event: { type: 'toolStart', callId: 'c', summary: '<b>Run</b>' } });
	send({ type: 'event', event: { type: 'permission', callId: 'c', summary: 's', detail: 'rm x', canDiff: true, sensitive: true } });
	const allow = win.document.querySelector('[data-answer="allow"]') as HTMLButtonElement;
	assert.ok(allow);
	assert.ok(win.document.querySelector('.warning'));
	allow.click();
	assert.deepEqual(posted.at(-1), { type: 'permission', id: 'c', answer: 'allow' });
	assert.equal(win.document.querySelector('.permission'), null);
	send({ type: 'event', event: { type: 'toolEnd', callId: 'c', ok: true, output: '<img src=x>' } });
	assert.equal(win.document.querySelector('.tool img'), null);
	assert.equal(win.document.querySelector('.tool summary b'), null);
	assert.equal($('transcript').querySelector('.output')?.textContent, '<img src=x>');
});

test('a busy chat shows live progress and approval waits', () => {
	const { send, $, dom } = load();
	send({ ...STATE, busy: true });
	assert.equal($('status').hidden, false);
	assert.match($('status').textContent ?? '', /Working/);
	send({ type: 'event', event: { type: 'permission', callId: 'x', summary: 's' } });
	assert.match($('status').textContent ?? '', /approval/);
	send({ type: 'event', event: { type: 'toolEnd', callId: 'x', ok: true, output: '' } });
	assert.match($('status').textContent ?? '', /Working/);
	send({ ...STATE, busy: false });
	assert.equal($('status').hidden, true);
	dom.window.close();
});

test('messages typed while busy are queued and can be removed', () => {
	const { posted, send, $, win, dom } = load();
	send({ ...STATE, busy: true });
	$('input').value = 'second request';
	$('input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.deepEqual(posted.at(-1), { type: 'send', text: 'second request', includeSelection: false, attachments: [] });
	send({ ...STATE, busy: true, queue: [{ index: 0, text: 'second request' }] });
	assert.equal($('queue').hidden, false);
	assert.match($('queue').textContent ?? '', /second request/);
	assert.match($('status').textContent ?? '', /1 queued/);
	(win.document.querySelector('#queue button') as HTMLButtonElement).click();
	assert.deepEqual(posted.at(-1), { type: 'removeQueued', id: '0' });
	send({ ...STATE, busy: false, queue: [] });
	assert.equal($('queue').hidden, true);
	dom.window.close();
});

test('limit errors offer the subscription page', () => {
	const { posted, send, win } = load();
	send(STATE);
	send({ type: 'event', event: { type: 'error', message: 'limit', showBuy: true } });
	(win.document.querySelector('.error button') as HTMLButtonElement).click();
	assert.equal(posted.at(-1)?.type, 'buy');
});

test('transcript redraw and streamed text render', async () => {
	const { send, $ } = load();
	send(STATE);
	send({ type: 'transcript', items: [{ kind: 'user', text: 'q' }, { kind: 'assistant', text: '**a**' }, { kind: 'tool', summary: 's', output: 'o', ok: true }] });
	assert.equal($('transcript').querySelectorAll('.message').length, 2);
	assert.ok($('transcript').querySelector('strong'));
	send({ type: 'event', event: { type: 'text', text: 'streamed' } });
	send({ type: 'event', event: { type: 'done' } });
	assert.match($('transcript').textContent ?? '', /streamed/);
	send({ type: 'transcript', items: [{ kind: 'notice', text: 'Older messages above were summarized' }] });
	assert.match($('transcript').querySelector('.notice')?.textContent ?? '', /summarized/);
	send({ type: 'event', event: { type: 'usage', usage: { promptTokens: 40, cachedTokens: 30, cacheWriteTokens: 5, reasoningTokens: 7, cost: 0.00000418 } } });
	assert.match($('contextUsage').title, /40 of 100 prompt tokens, 30 from cache, 5 written to cache, 7 reasoning, cost \$0\.000004/);
});
