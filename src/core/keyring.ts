/** Helpers for the saved-key ring. Storage lives in the VS Code layer. */

export interface StoredKey {
	id: string;
	label: string;
	gateway: string;
	key: string;
}

export function maskKey(key: string): string {
	return key.length <= 8 ? '••••' : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/** Fallback label when a key is saved without a name. */
export function defaultKeyLabel(key: string): string {
	return maskKey(key);
}
