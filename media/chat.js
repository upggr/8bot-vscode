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
	let liveChars = 0;
	/** Learned $ per token per model, from completed requests this session. Used for live cost hints only. */
	const costRates = new Map();
	let setupOpen = false;
	let lastActivity = Date.now();
	let awaitingApproval = false;
	let statusTimer;
	const tools = new Map();

	// Kept in sync with src/core/attachments.ts.
	const MAX_ATTACHMENTS = 5;
	const MAX_ATTACHMENT_TEXT = 50000;
	const MAX_ATTACHMENT_IMAGE_BYTES = 8 * 1024 * 1024;
	const MAX_IMAGE_DIMENSION = 1600;
	let pendingAttachments = [];
	let screenshotCount = 0;

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

	function renderStatus() {
		const status = $('status');
		status.hidden = !state.busy;
		if (!state.busy) { return; }
		const seconds = Math.floor((Date.now() - lastActivity) / 1000);
		const queued = state.queue && state.queue.length ? ' · ' + state.queue.length + ' queued' : '';
		const base = awaitingApproval ? 'Waiting for your approval' : liveChars ? 'Thinking... ' + seconds + 's' : seconds < 3 ? 'Working...' : 'Thinking... ' + seconds + 's';
		const liveTokens = Math.ceil(liveChars / 4);
		const rate = costRates.get(state.liveModel || state.model);
		const estimate = liveChars && rate ? ' (~$' + (liveTokens * rate).toFixed(6) + ')' : '';
		const live = liveChars ? ' · ~' + liveTokens.toLocaleString() + ' tokens out' + estimate : '';
		status.textContent = base + live + queued;
	}

	function updateStatusTimer() {
		if (state.busy && !statusTimer) {
			lastActivity = Date.now();
			statusTimer = setInterval(renderStatus, 1000);
		} else if (!state.busy && statusTimer) {
			clearInterval(statusTimer);
			statusTimer = undefined;
			awaitingApproval = false;
		}
		renderStatus();
	}

	function onEvent(event) {
		lastActivity = Date.now();
		if (event.type === 'permission') { awaitingApproval = true; }
		if (event.type === 'toolEnd') { awaitingApproval = false; }
		renderStatus();
		switch (event.type) {
			case 'user': {
				endAssistant();
				liveChars = 0;
				const box = add(element('div', 'message user', event.text));
				(event.attachments || []).forEach(a => {
					box.appendChild(element('span', 'chip', (a.isImage ? '🖼 ' : '📄 ') + a.name));
				});
				break;
			}
			case 'text':
				liveChars += event.text.length;
				appendAssistant(event.text);
				break;
			case 'reasoning':
				liveChars += event.text.length;
				if (!reasoningEl) {
					const box = add(element('details', 'reasoning'));
					box.appendChild(element('summary', '', 'Thinking'));
					reasoningEl = box.appendChild(element('div', 'output'));
				}
				reasoningEl.textContent += event.text;
				reasoningEl.parentElement.querySelector('summary').textContent = 'Thinking · ~' + Math.ceil(liveChars / 4).toLocaleString() + ' tokens';
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
			case 'usage': {
				if (event.usage.model && state.model === 'auto') { $('model').title = 'Routed to ' + event.usage.model; }
				if (event.usage.model) { state.liveModel = event.usage.model; }
				const total = (event.usage.promptTokens || 0) + (event.usage.completionTokens || 0);
				if (event.usage.cost && total > 0) { costRates.set(event.usage.model || state.model, event.usage.cost / total); }
				showContext(event.usage);
				break;
			}
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
		// Render again after the switch: text and reasoning events grow the live token count.
		renderStatus();
	}

	function isImage(file) {
		return file.type.indexOf('image/') === 0;
	}

	function isLikelyText(file) {
		if (isImage(file)) { return false; }
		if (file.type && file.type.indexOf('text/') === 0) { return true; }
		return /\.(txt|md|markdown|json|jsonc|ya?ml|csv|tsv|log|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|toml|ini|env|gitignore|dockerfile)$/i.test(file.name);
	}

	function downscaleImage(file) {
		return new Promise(resolve => {
			const reader = new FileReader();
			reader.onload = () => {
				const img = new Image();
				img.onload = () => {
					const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height));
					const canvas = document.createElement('canvas');
					canvas.width = Math.max(1, Math.round(img.width * scale));
					canvas.height = Math.max(1, Math.round(img.height * scale));
					const ctx = canvas.getContext('2d');
					ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
					resolve(canvas.toDataURL('image/png'));
				};
				img.onerror = () => resolve(reader.result);
				img.src = reader.result;
			};
			reader.onerror = () => resolve(undefined);
			reader.readAsDataURL(file);
		});
	}

	function readText(file) {
		return new Promise(resolve => {
			const reader = new FileReader();
			reader.onload = () => {
				const text = String(reader.result || '');
				resolve({ text: text.slice(0, MAX_ATTACHMENT_TEXT), truncated: text.length > MAX_ATTACHMENT_TEXT });
			};
			reader.onerror = () => resolve({ text: '[Could not read this file.]', truncated: false });
			reader.readAsText(file);
		});
	}

	async function addFiles(files) {
		const list = Array.from(files || []);
		for (const file of list) {
			if (pendingAttachments.length >= MAX_ATTACHMENTS) {
				add(element('div', 'message notice', 'Only ' + MAX_ATTACHMENTS + ' attachments are kept at a time.'));
				break;
			}
			if (isImage(file)) {
				if (file.size > MAX_ATTACHMENT_IMAGE_BYTES) {
					add(element('div', 'message notice', file.name + ' is too large to attach.'));
					continue;
				}
				const dataUrl = await downscaleImage(file);
				if (dataUrl) {
					screenshotCount += 1;
					pendingAttachments.push({ name: file.name || ('screenshot-' + screenshotCount + '.png'), mime: 'image/png', dataUrl: dataUrl });
				}
			} else if (isLikelyText(file)) {
				const result = await readText(file);
				pendingAttachments.push({ name: file.name, mime: file.type || 'text/plain', text: result.text, truncated: result.truncated });
			} else {
				add(element('div', 'message notice', file.name + ' is a type 8bot cannot read yet. Attach a text file or an image.'));
			}
		}
		renderAttachments();
	}

	function removeAttachment(index) {
		pendingAttachments.splice(index, 1);
		renderAttachments();
	}

	function renderAttachments() {
		const bar = $('attachments');
		bar.replaceChildren();
		bar.hidden = pendingAttachments.length === 0;
		pendingAttachments.forEach((attachment, index) => {
			const chip = element('span', 'chip', (attachment.dataUrl ? '🖼 ' : '📄 ') + attachment.name);
			const remove = element('button', 'link', '×');
			remove.type = 'button';
			remove.title = 'Remove';
			remove.addEventListener('click', () => removeAttachment(index));
			chip.appendChild(remove);
			bar.appendChild(chip);
		});
	}

	function showContext(usage) {
		const tokens = typeof usage === 'number' ? usage : usage && usage.promptTokens;
		const model = (state.models || []).find(m => m.id === state.model);
		const meter = $('contextUsage');
		meter.textContent = tokens && model ? Math.min(100, Math.round(tokens / model.contextWindow * 100)) + '% context' : '';
		if (!tokens || !model) { meter.title = ''; return; }
		const parts = [tokens.toLocaleString() + ' of ' + model.contextWindow.toLocaleString() + ' prompt tokens'];
		if (usage.cachedTokens) { parts.push(usage.cachedTokens.toLocaleString() + ' from cache'); }
		if (usage.cacheWriteTokens) { parts.push(usage.cacheWriteTokens.toLocaleString() + ' written to cache'); }
		if (usage.reasoningTokens) { parts.push(usage.reasoningTokens.toLocaleString() + ' reasoning'); }
		if (usage.cost) { parts.push('cost $' + (usage.cost < 0.01 ? usage.cost.toFixed(6) : usage.cost.toFixed(4))); }
		meter.title = parts.join(', ');
	}

	function applyState(next) {
		state = next;
		if (!next.hasKey || setupOpen) {
			if (!$('gateway').value) { $('gateway').value = next.gateway; }
		}
		showSetup(!next.hasKey || setupOpen);
		if (!next.hasKey) { return; }

		const models = next.models.length ? next.models : [{ id: next.model, name: next.model, efforts: [] }];
		fill($('model'), models.map(m => ({ value: m.id, label: m.deprecated ? '⚠ ' + m.name : m.name })), next.model);
		fill($('mode'), next.modes.map(m => ({ value: m.id, label: m.label, title: m.detail })), next.mode);
		$('mode').classList.toggle('danger', next.mode === 'bypassPermissions');

		const current = models.find(m => m.id === next.model);
		const efforts = current ? current.efforts : [];
		$('effort').hidden = efforts.length === 0;
		fill($('effort'), [{ value: '', label: 'Default effort' }].concat(efforts.map(e => ({ value: e, label: e }))), efforts.includes(next.effort) ? next.effort : '');

		const sessions = next.sessions.slice();
		if (!sessions.some(s => s.id === next.sessionId)) { sessions.unshift({ id: next.sessionId, title: 'New chat' }); }
		fill($('sessions'), sessions.map(s => ({ value: s.id, label: s.title })), next.sessionId);

		updateStatusTimer();
		$('send').hidden = false;
		$('stop').hidden = !next.busy;
		const queueBar = $('queue');
		queueBar.replaceChildren();
		queueBar.hidden = !next.queue || next.queue.length === 0;
		(next.queue || []).forEach(item => {
			const chip = element('span', 'chip', '⏳ ' + item.text.slice(0, 60));
			const remove = element('button', 'link', '×');
			remove.type = 'button';
			remove.title = 'Remove from queue';
			remove.addEventListener('click', () => post('removeQueued', { id: String(item.index) }));
			chip.appendChild(remove);
			queueBar.appendChild(chip);
		});
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
				const box = add(element('div', 'message user', item.text));
				if (item.hasImage) { box.appendChild(element('span', 'chip', '🖼 image')); }
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
		if (!text && pendingAttachments.length === 0) { return; }
		input.value = '';
		const attachments = pendingAttachments;
		pendingAttachments = [];
		renderAttachments();
		post('send', { text: text, includeSelection: !$('selectionChip').hidden && $('includeSelection').checked, attachments: attachments });
	}

	input.addEventListener('keydown', event => {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			send();
		}
	});
	$('send').addEventListener('click', send);
	$('stop').addEventListener('click', () => post('stop', { value: 'all' }));
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
	$('attach').addEventListener('click', () => $('fileInput').click());
	$('fileInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
	input.addEventListener('paste', event => {
		const files = Array.from(event.clipboardData && event.clipboardData.files || []);
		if (files.length) { event.preventDefault(); addFiles(files); }
	});
	['dragenter', 'dragover'].forEach(name => {
		document.body.addEventListener(name, event => { event.preventDefault(); document.body.classList.add('dragging'); });
	});
	['dragleave', 'drop'].forEach(name => {
		document.body.addEventListener(name, event => { event.preventDefault(); document.body.classList.remove('dragging'); });
	});
	document.body.addEventListener('drop', event => {
		const files = event.dataTransfer && event.dataTransfer.files;
		if (files && files.length) { addFiles(files); }
	});
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
