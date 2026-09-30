import type { ClassifyError } from './messages';

/**
 * Auto mode: limits and bookkeeping, pure and without a browser.
 *
 * Auto mode sends a page's text out without a click, so everything that keeps it
 * from running away lives here where it can be tested: the switch, the money cap,
 * the daily count, the failure stop. See docs/auto-mode.md.
 */

/** USD 10, in millionths. Chosen by the person (2026-09-30). */
export const AUTO_CAP_MICRO = 10_000_000;

/** A backstop for a page that reloads itself: at most this many model requests a day. */
export const AUTO_DAILY_REQUESTS = 300;

/** Consecutive failures after which auto mode stops and waits for the person. */
export const AUTO_MAX_FAILURES = 3;

/** Two model requests are at least this far apart. */
export const AUTO_MIN_GAP_MS = 2000;

/** Tabs waiting for a turn; when full the oldest is dropped. */
export const AUTO_MAX_QUEUE = 5;

/** How long a stored judgement may be reused for the same page content. */
export const AUTO_RESULT_TTL_MS = 6 * 60 * 60 * 1000;

/** Jev list price: USD 0.042 per million input tokens, output free. The gateway
 * route is charged at the same rate here, which is a working assumption. */
export const AUTO_INPUT_MICRO_PER_MTOK = 42_000;

/** Reserved before a request is sent: the most a 2000-word page plus questions can
 * cost. Real pages measured 1,600 to 3,700 tokens. */
export const AUTO_RESERVE_TOKENS = 12_000;

export function costMicro(inputTokens: number): number {
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return 0;
  return Math.ceil((inputTokens * AUTO_INPUT_MICRO_PER_MTOK) / 1_000_000);
}

export const AUTO_RESERVE_MICRO = costMicro(AUTO_RESERVE_TOKENS);

export interface AutoState {
  /** The master switch. Off until the person turns it on. */
  enabled: boolean;
  /** Everything spent since the last reset, in millionths of a dollar. */
  spentMicro: number;
  /** Local date the daily count belongs to, `YYYY-MM-DD`. */
  day: string;
  /** Model requests made on `day`. */
  dayCount: number;
  /** Failures in a row; a success sets it to zero. */
  failures: number;
  /** Stopped after too many failures; only the person restarts it. */
  paused: boolean;
}

export const EMPTY_AUTO_STATE: AutoState = {
  enabled: false,
  spentMicro: 0,
  day: '',
  dayCount: 0,
  failures: 0,
  paused: false,
};

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function normalizeAutoState(raw: unknown): AutoState {
  if (typeof raw !== 'object' || raw === null) return EMPTY_AUTO_STATE;
  const record = raw as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    spentMicro: count(record.spentMicro),
    day: typeof record.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.day) ? record.day : '',
    dayCount: count(record.dayCount),
    failures: count(record.failures),
    paused: record.paused === true,
  };
}

export function dayOf(now: number): string {
  const date = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The daily count belongs to a day; on a new day it starts again. */
export function rolledTo(state: AutoState, now: number): AutoState {
  const today = dayOf(now);
  return state.day === today ? state : { ...state, day: today, dayCount: 0 };
}

export type AutoRefusal = 'off' | 'paused' | 'cap' | 'daily';

export type BeginResult =
  | { ok: true; state: AutoState; reservedMicro: number }
  | { ok: false; reason: AutoRefusal; state: AutoState };

/**
 * Asks for permission to send one request. On success the worst-case cost is
 * already counted, so a worker that dies mid-request leaves the spend too high,
 * never too low.
 */
export function beginRequest(state: AutoState, now: number): BeginResult {
  const today = rolledTo(state, now);
  if (!today.enabled) return { ok: false, reason: 'off', state: today };
  if (today.paused) return { ok: false, reason: 'paused', state: today };
  if (today.spentMicro + AUTO_RESERVE_MICRO > AUTO_CAP_MICRO) return { ok: false, reason: 'cap', state: today };
  if (today.dayCount >= AUTO_DAILY_REQUESTS) return { ok: false, reason: 'daily', state: today };
  return {
    ok: true,
    reservedMicro: AUTO_RESERVE_MICRO,
    state: { ...today, spentMicro: today.spentMicro + AUTO_RESERVE_MICRO, dayCount: today.dayCount + 1 },
  };
}

/** Errors that mean the request never reached a billable answer. */
const UNBILLED: readonly ClassifyError[] = ['no-key', 'auth', 'rate-limited', 'network'];

export type AutoOutcome = { ok: true; inputTokens: number } | { ok: false; error: ClassifyError };

/** Replaces the reservation with what happened. Failures count toward the stop. */
export function settleRequest(state: AutoState, reservedMicro: number, outcome: AutoOutcome): AutoState {
  const base = Math.max(0, state.spentMicro - reservedMicro);
  if (outcome.ok) {
    return { ...state, spentMicro: base + costMicro(outcome.inputTokens), failures: 0 };
  }
  const failures = state.failures + 1;
  return {
    ...state,
    spentMicro: UNBILLED.includes(outcome.error) ? base : base + reservedMicro,
    failures,
    paused: state.paused || failures >= AUTO_MAX_FAILURES,
  };
}

export function withEnabled(state: AutoState, enabled: boolean): AutoState {
  return { ...state, enabled };
}

/** Restarts after a failure stop. The spend and the daily count are kept. */
export function resumed(state: AutoState): AutoState {
  return { ...state, paused: false, failures: 0 };
}

export function withSpendReset(state: AutoState): AutoState {
  return { ...state, spentMicro: 0, dayCount: 0 };
}

export function remainingMicro(state: AutoState): number {
  return Math.max(0, AUTO_CAP_MICRO - state.spentMicro);
}

/** Which refusal a state would give right now, or null when a request is allowed. */
export function refusalOf(state: AutoState, now: number): AutoRefusal | null {
  const result = beginRequest(state, now);
  return result.ok ? null : result.reason;
}

// --- which pages -----------------------------------------------------------------

const NEVER_AUTO_HOSTS = [
  'x.com',
  'twitter.com',
  'api.typesafe.ai',
  'ai-gateway.vercel.sh',
  'api.openai.com',
  'api.deepseek.com',
  'api.huodale.site',
];

/** `https://example.com/*`, the form the browser stores an authorisation in, or
 * null when the address is not an ordinary web page. */
export function originPatternOf(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname === '') return null;
  return `${url.protocol}//${url.hostname}/*`;
}

export function hostOfPattern(pattern: string): string | null {
  const match = /^https?:\/\/([^/*:]+)\/\*$/.exec(pattern);
  return match ? match[1].toLowerCase() : null;
}

/** Sites auto mode is never offered on, whatever the person has authorised. */
export function neverAuto(host: string): boolean {
  const lower = host.toLowerCase();
  return NEVER_AUTO_HOSTS.some((blocked) => lower === blocked || lower.endsWith(`.${blocked}`));
}

/** Whether the panel may offer to authorise this page's site. */
export function canAuthorise(address: string): boolean {
  const pattern = originPatternOf(address);
  if (pattern === null) return false;
  const host = hostOfPattern(pattern);
  return host !== null && !neverAuto(host);
}

/** One judged page per tab and address: the query string and fragment are not part
 * of "the same page". */
export function pageKeyOf(address: string): string {
  try {
    const url = new URL(address);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return address;
  }
}

/** `$0.0013`: four decimals, because a page costs a hundredth of a cent. */
export function formatDollars(micro: number): string {
  return `$${(Math.max(0, micro) / 1_000_000).toFixed(4)}`;
}
