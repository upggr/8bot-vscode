(function () {
	'use strict';
	const vscode = acquireVsCodeApi();
	const render = window.EightBotMarkdown.render;
	const $ = id => document.getElementById(id);
	const transcript = $('transcript');
	const input = $('input');

	let state = {};
	let assistantEl;
	let assistantText = '';
	let renderQueued = false;
	let reasoningEl;
	let setupOpen = false;
	const tools = new Map();

	function post(type, extra) {
		vscode.postMessage(Object.assign({ type: type }, extra));
	}

	function element(tag, className, text) {
		const el = document.createElement(tag);
		if (className) { el.className = className; }
		if (text !== undefined) { el.textContent = text; }
		return el;
	}

	function scroll() {
		transcript.scrollTop = transcript.scrollHeight;
	}

	function add(el) {
		transcript.appendChild(el);
		scroll();
		return el;
	}

	function fill(select, options, value) {
		select.replaceChildren(...options.map(o => {
			const option = element('option', '', o.label);
			option.value = o.value;
			if (o.title) { option.title = o.title; }
			return option;
		}));
		select.value = value;
	}

	function endAssistant() {
		if (assistantEl) { assistantEl.innerHTML = render(assistantText); }
		assistantEl = undefined;
		assistantText = '';
		reasoningEl = undefined;
	}

	function appendAssistant(text) {
		if (!assistantEl) { assistantEl = add(element('div', 'message assistant')); }
		assistantText += text;
		if (!renderQueued) {
			renderQueued = true;
			requestAnimationFrame(() => {
				renderQueued = false;
				if (assistantEl) {
					assistantEl.innerHTML = render(assistantText);
					scroll();
				}
			});
		}
	}

	function toolCard(summary) {
		const card = element('details', 'tool running');
		const head = element('summary', '', summary);
		const output = element('pre', 'output');
		card.append(head, output);
		return card;
	}

	function finishTool(card, ok, output) {
		card.classList.remove('running');
		card.classList.add(ok ? 'ok' : 'failed');
		card.querySelector('.output').textContent = output;
		const permission = card.querySelector('.permission');
		if (permission) { permission.remove(); }
	}

	function showPermission(event) {
		const card = tools.get(event.callId);
		if (!card) { return; }
		card.open = true;
		const box = element('div', 'permission');
		if (event.sensitive) { box.appendChild(element('p', 'warning', 'This touches a sensitive file or a location that can run code.')); }
		if (event.detail) { box.appendChild(element('code', 'command', event.detail)); }
		const buttons = element('div', 'row');
		const answer = value => { box.remove(); post('permission', { id: event.callId, answer: value }); };
		if (event.canDiff) {
			const diff = element('button', 'secondary', 'View diff');
			diff.type = 'button';
			diff.addEventListener('click', () => post('openDiff', { id: event.callId }));
			buttons.appendChild(diff);
		}
		[['Allow', 'allow', ''], ['Always', 'always', 'secondary'], ['Deny', 'deny', 'secondary']].forEach(([label, value, cls]) => {
			const button = element('button', cls, label);
			button.type = 'button';
			button.dataset.answer = value;
			button.addEventListener('click', () => answer(value));
			buttons.appendChild(button);
		});
		box.appendChild(buttons);
		card.appendChild(box);
		scroll();
	}

	function showError(message, showBuy) {
		const box = add(element('div', 'message error', message));
		if (showBuy) {
			const button = element('button', 'secondary', 'Get a subscription from BUY IT');
			button.type = 'button';
			button.addEventListener('click', () => post('buy'));
			box.appendChild(button);
		}
	}

	function onEvent(event) {
		switch (event.type) {
			case 'user':
				endAssistant();
				add(element('div', 'message user', event.text));
				break;
			case 'text':
				appendAssistant(event.text);
				break;
			case 'reasoning':
				if (!reasoningEl) {
					const box = add(element('details', 'reasoning'));
					box.appendChild(element('summary', '', 'Thinking'));
					reasoningEl = box.appendChild(element('div', 'output'));
				}
				reasoningEl.textContent += event.text;
				break;
			case 'toolStart': {
				endAssistant();
				const card = add(toolCard(event.summary));
				tools.set(event.callId, card);
				break;
			}
			case 'permission':
				showPermission(event);
				break;
			case 'toolEnd': {
				const card = tools.get(event.callId);
				if (card) { finishTool(card, event.ok, event.output); }
				break;
			}
			case 'usage':
				if (event.usage.model && state.model === 'auto') { $('model').title = 'Routed to ' + event.usage.model; }
				showContext(event.usage.promptTokens, event.usage.cachedTokens);
				break;
			case 'notice':
				endAssistant();
				add(element('div', 'message notice', event.message));
				break;
			case 'info': {
				endAssistant();
				const info = add(element('div', 'message notice'));
				info.innerHTML = render(event.text);
				break;
			}
			case 'error':
				endAssistant();
				showError(event.message, event.showBuy);
				break;
			case 'done':
				endAssistant();
				break;
			default:
				break;
		}
	}

	function showContext(tokens, cached) {
		const model = (state.models || []).find(m => m.id === state.model);
		const meter = $('contextUsage');
		meter.textContent = tokens && model ? Math.min(100, Math.round(tokens / model.contextWindow * 100)) + '% context' : '';
		meter.title = tokens && model ? tokens.toLocaleString() + ' of ' + model.contextWindow.toLocaleString() + ' tokens' + (cached ? ', ' + cached.toLocaleString() + ' from cache' : '') : '';
	}

	function applyState(next) {
		state = next;
		if (!next.hasKey || setupOpen) {
			if (!$('gateway').value) { $('gateway').value = next.gateway; }
		}
		showSetup(!next.hasKey || setupOpen);
		if (!next.hasKey) { return; }

		const models = next.models.length ? next.models : [{ id: next.model, name: next.model, efforts: [] }];
		fill($('model'), models.map(m => ({ value: m.id, label: m.name })), next.model);
		fill($('mode'), next.modes.map(m => ({ value: m.id, label: m.label, title: m.detail })), next.mode);
		$('mode').classList.toggle('danger', next.mode === 'bypassPermissions');

		const current = models.find(m => m.id === next.model);
		const efforts = current ? current.efforts : [];
		$('effort').hidden = efforts.length === 0;
		fill($('effort'), [{ value: '', label: 'Default effort' }].concat(efforts.map(e => ({ value: e, label: e }))), efforts.includes(next.effort) ? next.effort : '');

		const sessions = next.sessions.slice();
		if (!sessions.some(s => s.id === next.sessionId)) { sessions.unshift({ id: next.sessionId, title: 'New chat' }); }
		fill($('sessions'), sessions.map(s => ({ value: s.id, label: s.title })), next.sessionId);

		$('send').hidden = next.busy;
		$('stop').hidden = !next.busy;
		const credits = $('credits');
		credits.textContent = next.credits.label;
		credits.title = next.credits.detail;
		credits.className = 'link ' + next.credits.level;
		$('selectionChip').hidden = !next.selection;
		if (next.selection) { $('selectionText').textContent = next.selection.file + ':' + next.selection.lines; }
		showContext(next.promptTokens);
	}

	function drawTranscript(items) {
		endAssistant();
		tools.clear();
		transcript.replaceChildren();
		items.forEach(item => {
			if (item.kind === 'user') {
				add(element('div', 'message user', item.text));
			} else if (item.kind === 'notice') {
				add(element('div', 'message notice', item.text));
			} else if (item.kind === 'assistant') {
				add(element('div', 'message assistant')).innerHTML = render(item.text);
			} else {
				finishTool(add(toolCard(item.summary)), item.ok, item.output);
			}
		});
	}

	function showSetup(open) {
		$('welcome').hidden = !open;
		$('app').hidden = open;
		$('closeSetup').hidden = !state.hasKey;
	}

	function saveConnection() {
		$('setupError').hidden = true;
		$('saveConnection').disabled = true;
		post('saveConnection', { gateway: $('gateway').value.trim(), key: $('apiKey').value.trim() });
	}

	function send() {
		const text = input.value.trim();
		if (!text || state.busy) { return; }
		input.value = '';
		post('send', { text: text, includeSelection: !$('selectionChip').hidden && $('includeSelection').checked });
	}

	input.addEventListener('keydown', event => {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			send();
		}
	});
	$('send').addEventListener('click', send);
	$('stop').addEventListener('click', () => post('stop'));
	$('newChat').addEventListener('click', () => post('newChat'));
	$('saveConnection').addEventListener('click', saveConnection);
	$('apiKey').addEventListener('keydown', event => { if (event.key === 'Enter') { saveConnection(); } });
	$('closeSetup').addEventListener('click', () => { setupOpen = false; showSetup(false); });
	$('getSubscription').addEventListener('click', () => post('buy'));
	$('credits').addEventListener('click', () => post('credits'));
	$('model').addEventListener('change', e => post('setModel', { value: e.target.value }));
	$('effort').addEventListener('change', e => post('setEffort', { value: e.target.value }));
	$('mode').addEventListener('change', e => post('setMode', { value: e.target.value }));
	$('sessions').addEventListener('change', e => post('loadSession', { value: e.target.value }));
	transcript.addEventListener('click', event => {
		if (event.target.classList.contains('copy')) {
			const code = event.target.parentElement.querySelector('code').textContent;
			navigator.clipboard.writeText(code).then(() => { event.target.textContent = 'Copied'; });
		}
	});

	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'state') { applyState(message); }
		else if (message.type === 'transcript') { drawTranscript(message.items); }
		else if (message.type === 'event') { onEvent(message.event); }
		else if (message.type === 'showSetup') { setupOpen = true; $('gateway').value = state.gateway || ''; showSetup(true); $('apiKey').focus(); }
		else if (message.type === 'setupResult') {
			$('saveConnection').disabled = false;
			$('setupError').textContent = message.error || '';
			$('setupError').hidden = !message.error;
			if (!message.error) { $('apiKey').value = ''; setupOpen = false; showSetup(!state.hasKey); }
		}
		else if (message.type === 'focusInput') { input.value = message.text || ''; input.focus(); }
	});

	post('ready');
})();
