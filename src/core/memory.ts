import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_MEMORY_CHARS = 20_000;

export async function readMemory(file: string | undefined): Promise<string> {
	if (!file) { return ''; }
	try {
		return (await fs.readFile(file, 'utf8')).trim().slice(-MAX_MEMORY_CHARS);
	} catch {
		return '';
	}
}

async function write(file: string, text: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
}

/** Parallel sub-agents can save notes at the same moment, so each read-modify-write waits its turn. */
let pending: Promise<unknown> = Promise.resolve();
function locked<T>(work: () => Promise<T>): Promise<T> {
	const result = pending.then(work);
	pending = result.catch(() => undefined);
	return result;
}

/** Adds a note. Returns false if the same note is already saved. */
export function addMemory(file: string, note: string): Promise<boolean> {
	const clean = note.replace(/\s+/g, ' ').trim();
	if (!clean) { return Promise.reject(new Error('A note is required.')); }
	return locked(async () => {
		const current = await readMemory(file);
		const line = `- ${clean}`;
		if (current.split('\n').includes(line)) { return false; }
		await write(file, `${current ? `${current}\n` : ''}${line}\n`);
		return true;
	});
}

/** Removes notes containing the text and returns how many were removed. */
export function removeMemory(file: string, text: string): Promise<number> {
	const needle = text.trim().toLowerCase();
	if (!needle) { return Promise.reject(new Error('Text to match is required.')); }
	return locked(async () => {
		const lines = (await readMemory(file)).split('\n').filter(Boolean);
		const kept = lines.filter(line => !line.toLowerCase().includes(needle));
		if (kept.length !== lines.length) { await write(file, kept.length ? `${kept.join('\n')}\n` : ''); }
		return lines.length - kept.length;
	});
}
