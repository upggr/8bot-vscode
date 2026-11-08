import { LiveLimit } from './gateway';

export const BUY_URL = 'https://buy-it.gr/8os';

export interface SpendRecord {
	/** Calendar month as YYYY-MM. */
	month: string;
	total: number;
}

export type CreditLevel = 'ok' | 'low' | 'empty';

export interface CreditStatus {
	label: string;
	detail: string;
	level: CreditLevel;
	live: boolean;
}

const LOW_RATIO = 0.1;

export function currentMonth(now = new Date()): string {
	return now.toISOString().slice(0, 7);
}

export function addSpend(record: SpendRecord | undefined, cost: number, now = new Date()): SpendRecord {
	const month = currentMonth(now);
	return { month, total: (record?.month === month ? record.total : 0) + cost };
}

export function money(value: number): string {
	return `$${value < 1 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}

function level(remaining: number, limit: number): CreditLevel {
	if (remaining <= 0) { return 'empty'; }
	return remaining / limit <= LOW_RATIO ? 'low' : 'ok';
}

/** Prefers the live Pax8 limit. Otherwise compares local spend with the user's own limit. */
export function creditStatus(record: SpendRecord | undefined, userLimit: number, live?: LiveLimit, now = new Date()): CreditStatus {
	if (live) {
		const reset = live.resetsAt ? ` Resets ${live.resetsAt.slice(0, 10)}.` : '';
		return {
			label: `${money(live.remaining)} left`,
			detail: `Live Pax8 limit: ${money(live.used)} used of ${money(live.limit)}${live.period ? ` (${live.period})` : ''}.${reset}`,
			level: live.reached ? 'empty' : level(live.remaining, live.limit),
			live: true,
		};
	}
	const spent = record?.month === currentMonth(now) ? record.total : 0;
	if (userLimit > 0) {
		const remaining = Math.max(userLimit - spent, 0);
		return {
			label: `${money(remaining)} left`,
			detail: `${money(spent)} of your ${money(userLimit)} monthly limit, counted on this computer from gateway costs.`,
			level: level(remaining, userLimit),
			live: false,
		};
	}
	return {
		label: `${money(spent)} this month`,
		detail: 'Counted on this computer from gateway costs. API keys cannot read the account balance. Connect a Pax8 account or set a monthly limit to see what is left.',
		level: 'ok',
		live: false,
	};
}
