// Dumps the RAW usage payloads the gateway sends, before 8bot parses them,
// so the reported `cost` can be checked against the account's real billing.
// Usage: node scripts/raw-usage-probe.mjs [model]
// Needs EIGHTOS_API_KEY in .env. Spends a tiny amount of gateway credit.
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
	.split('\n').filter(l => /^\w+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));

const baseUrl = env.EIGHTOS_BASE_URL ?? 'https://api.8os.com';
const apiKey = env.EIGHTOS_API_KEY;
if (!apiKey) { throw new Error('EIGHTOS_API_KEY is missing from .env'); }
const model = process.argv[2] ?? 'claude-haiku-5-5';

/** One streamed request; returns every raw usage object plus any cost-ish headers. */
async function probe(label, body) {
	const response = await fetch(`${baseUrl}/v1/chat/completions`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
		body: JSON.stringify({ ...body, model, stream: true, stream_options: { include_usage: true } }),
	});
	console.log(`\n=== ${label} — HTTP ${response.status} ===`);
	for (const [k, v] of response.headers) {
		if (/cost|usage|credit|price|token|guard|risk|limit/i.test(k)) { console.log(`header ${k}: ${v}`); }
	}
	if (!response.ok) { console.log(await response.text()); return []; }

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	const usages = [];
	for (;;) {
		const { value, done } = await reader.read();
		buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
		let nl;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, nl).replace(/\r$/, '');
			buffer = buffer.slice(nl + 1);
			if (!line.startsWith('data:')) { continue; }
			const data = line.slice(5).trim();
			if (data === '[DONE]') { continue; }
			let chunk;
			try { chunk = JSON.parse(data); } catch { continue; }
			if (chunk.usage) { usages.push(chunk.usage); }
			const delta = chunk.choices?.[0]?.delta;
			if (delta?.content) { text += delta.content; }
		}
		if (done) { break; }
	}
	console.log(`reply: ${JSON.stringify(text.slice(0, 120))}`);
	console.log(`raw usage objects seen: ${usages.length}`);
	usages.forEach((u, i) => console.log(`  [${i}] ${JSON.stringify(u)}`));
	return usages;
}

const tiny = await probe('tiny request ("say hi")', {
	messages: [{ role: 'user', content: 'Say hi in one word.' }],
	max_tokens: 20,
});

const bigger = await probe('bigger request (~600 word essay)', {
	messages: [{ role: 'user', content: 'Write about 600 words on why unit tests matter.' }],
	max_tokens: 1200,
});

// Non-streamed, so the single final usage object can be compared with the streamed one.
const nonStream = await fetch(`${baseUrl}/v1/chat/completions`, {
	method: 'POST',
	headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
	body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say hi in one word.' }], max_tokens: 20 }),
});
console.log(`\n=== non-streamed request — HTTP ${nonStream.status} ===`);
const nonStreamBody = await nonStream.json();
console.log(`usage: ${JSON.stringify(nonStreamBody.usage)}`);

const sum = arr => arr.reduce((t, u) => t + (u.cost ?? 0), 0);
console.log('\n=== what 8bot would add up ===');
console.log(`tiny:      cost sum = ${sum(tiny)}`);
console.log(`bigger:    cost sum = ${sum(bigger)}`);
console.log(`non-stream cost     = ${nonStreamBody.usage?.cost}`);
console.log(`\nTOTAL this probe = ${sum(tiny) + sum(bigger) + (nonStreamBody.usage?.cost ?? 0)}`);
console.log('If a single request repeats usage objects, 8bot double-counts by summing them all.');
