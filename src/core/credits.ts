import { LiveLimit } from './gateway';

export const BUY_URL = 'https://buy-it.gr/8os';

export interface SpendRecord {
	/** Calendar month as YYYY-MM. */
	month: string;
	total: number;
	/** Key fingerprint (first 8 chars) this total belongs to, so a key switch does not mix accounts. */
	keyId?: string;
}

export type CreditLevel = 'ok' | 'low' | 'empty';

export interface CreditStatus {
	label: string;
	detail: string;
	level: CreditLevel;
	live: boolean;
}

const LOW_RATIO = 0.1;
/** Local totals come from per-request gateway costs, which currently read high. Say so until it is fixed. */
const ESTIMATE_NOTE = 'This estimate is known to run a bit high — we are working on making it accurate.';

export function currentMonth(now = new Date()): string {
	return now.toISOString().slice(0, 7);
}

export function addSpend(record: SpendRecord | undefined, cost: number, now = new Date(), keyId?: string): SpendRecord {
	const month = currentMonth(now);
	const same = record?.month === month && record?.keyId === keyId;
	return { month, total: (same ? record.total : 0) + cost, keyId };
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

export function money(value: number, currency?: string): string {
	const symbol = (currency && SYMBOLS[currency.toUpperCase()]) ?? (currency ? `${currency.toUpperCase()} ` : '$');
	return `${symbol}${value < 1 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}

function level(remaining: number, limit: number): CreditLevel {
	if (remaining <= 0) { return 'empty'; }
	return remaining / limit <= LOW_RATIO ? 'low' : 'ok';
}

/** Prefers the live Pax8 limit. Otherwise compares local spend with the user's own limit. */
export function creditStatus(record: SpendRecord | undefined, userLimit: number, live?: LiveLimit, now = new Date(), keyId?: string): CreditStatus {
	if (live) {
		const reset = live.resetsAt ? ` Resets ${live.resetsAt.slice(0, 10)}.` : '';
		return {
			label: `${money(live.remaining, live.currency)} left`,
			detail: `Live Pax8 limit: ${money(live.used, live.currency)} used of ${money(live.limit, live.currency)}${live.period ? ` (${live.period})` : ''}.${reset}`,
			level: live.reached ? 'empty' : level(live.remaining, live.limit),
			live: true,
		};
	}
	// The local counter is per key and per month; an old key's or month's record is not this key's spend.
	const spent = record?.month === currentMonth(now) && record.keyId === keyId ? record.total : 0;
	if (userLimit > 0) {
		const remaining = Math.max(userLimit - spent, 0);
		return {
			label: `~${money(remaining)} left (est.)`,
			detail: `Estimated: ${money(spent)} of your ${money(userLimit)} monthly limit, counted on this computer from gateway costs, for this key only. ${ESTIMATE_NOTE}`,
			level: level(remaining, userLimit),
			live: false,
		};
	}
	return {
		label: `~${money(spent)} this month (est.)`,
		detail: `Estimated usage, counted on this computer from gateway costs, for the current key only. API keys cannot read the account balance, so connect a Pax8 account or set a monthly limit to see what is left. ${ESTIMATE_NOTE}`,
		level: 'ok',
		live: false,
	};
}
