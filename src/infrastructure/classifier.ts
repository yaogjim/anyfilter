import type { ClassifyError, ClassifyResult } from '../domain/messages';
import { postContentKey, type Post } from '../domain/post';
import type { ProviderId } from '../domain/provider';
import { activeKey } from '../domain/settings';
import type { Scores } from '../domain/verdict';
import type { ProviderAdapter } from './jev/provider-adapter';
import { typesafeDirectAdapter } from './jev/typesafe-direct-adapter';
import { vercelGatewayAdapter } from './jev/vercel-gateway-adapter';
import { cachedScores, rememberScores, scoresEpoch } from './score-cache';
import { loadSettings } from './settings-store';

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  vercel: vercelGatewayAdapter,
  typesafe: typesafeDirectAdapter,
};

/** Result of one provider call, shared by the feed and the text preview. */
export type TextOutcome =
  | { ok: true; scores: Scores; tokens: number; model: string; complete: boolean }
  | { ok: false; error: ClassifyError; detail: string };

/** A single provider call is abandoned after this long so a hung socket cannot
 * stall the whole feed behind one request. */
const REQUEST_TIMEOUT_MS = 20_000;
const RESTING_COOLDOWN_MS = 20_000;
const MAX_COOLDOWN_MS = 300_000;

let inFlight = 0;
const waiting: Array<() => void> = [];

/** Cooldown is tracked per provider: one provider rate-limiting us must not stop
 * requests to the other. */
const cooldownUntil: Record<ProviderId, number> = { vercel: 0, typesafe: 0 };
const cooldownStep: Record<ProviderId, number> = {
  vercel: RESTING_COOLDOWN_MS,
  typesafe: RESTING_COOLDOWN_MS,
};

/** Identical in-flight work is shared: two posts with the same text and the same
 * provider/question set wait on one request instead of paying twice. */
const inFlightRequests = new Map<string, Promise<TextOutcome>>();

type TextFailure = { ok: false; error: ClassifyError; detail: string };

function acquire(): Promise<void> {
  if (inFlight < 2) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      inFlight += 1;
      resolve();
    });
  });
}

function release(): void {
  inFlight -= 1;
  waiting.shift()?.();
}

function stateOf(post: Post): Record<string, unknown> {
  const state: Record<string, unknown> = {
    author: { handle: `@${post.handle}`, name: post.name },
    text: post.text,
  };
  if (post.quotedText) state.quoted = post.quotedText;
  if (post.parent) {
    state.replyingTo = { author: `@${post.parent.handle}`, text: post.parent.text };
  }
  return state;
}

function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function coolingDown(provider: ProviderId): TextFailure | null {
  const until = cooldownUntil[provider];
  if (Date.now() >= until) return null;
  const seconds = Math.ceil((until - Date.now()) / 1000);
  return { ok: false, error: 'rate-limited', detail: `cooling down, retry in ${seconds}s` };
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** Runs `fetch` under an abort timer; the timer is always cleared so a settled
 * response never leaves a pending timeout behind. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Shares one promise across every caller with the same key while it is pending;
 * later callers reuse the outcome instead of issuing a duplicate request. */
function dedupe(key: string, run: () => Promise<TextOutcome>): Promise<TextOutcome> {
  const existing = inFlightRequests.get(key);
  if (existing) return existing;
  const promise = run();
  inFlightRequests.set(key, promise);
  const clear = (): void => {
    if (inFlightRequests.get(key) === promise) inFlightRequests.delete(key);
  };
  promise.then(clear, clear);
  return promise;
}

/** Identity of one unit of work: provider, the exact question set, and the exact
 * post state. Two callers matching on all three can safely share one request. */
function requestKey(
  provider: ProviderId,
  questionsKey: string,
  state: unknown,
  questions: Record<string, string>,
): string {
  return [provider, questionsKey, JSON.stringify(questions), JSON.stringify(state)].join('\u0000');
}

/** Keeps only finite 0..1 answers for the ids we actually asked about. Missing or
 * invalid answers are reported as incomplete instead of being read as a zero. */
export function filterScores(
  scores: Scores,
  askedIds: readonly string[],
): { scores: Scores; complete: boolean } {
  const valid: Scores = {};
  let complete = true;
  for (const id of askedIds) {
    const value = scores[id];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
      valid[id] = value;
    } else {
      complete = false;
    }
  }
  return { scores: valid, complete };
}

async function runRequest(
  provider: ProviderId,
  key: string,
  state: unknown,
  questions: Record<string, string>,
  askedIds: readonly string[],
): Promise<TextOutcome> {
  const adapter = ADAPTERS[provider];
  const request = adapter.buildRequest(key, state, questions);
  let response: Response;
  try {
    response = await fetchWithTimeout(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
  } catch (error) {
    if (isAbort(error)) {
      return { ok: false, error: 'network', detail: `request timed out after ${REQUEST_TIMEOUT_MS}ms` };
    }
    throw error;
  }
  if (response.status === 429) {
    const wait = retryAfterMs(response.headers.get('retry-after')) ?? cooldownStep[provider];
    cooldownUntil[provider] = Date.now() + wait;
    cooldownStep[provider] = Math.min(cooldownStep[provider] * 2, MAX_COOLDOWN_MS);
    return { ok: false, error: 'rate-limited', detail: await response.text() };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: 'auth', detail: await response.text() };
  }
  if (!response.ok) {
    return { ok: false, error: 'bad-response', detail: `HTTP ${response.status}` };
  }
  const json: unknown = await response.json();
  const { scores, complete } = filterScores(adapter.parseScores(json), askedIds);
  if (askedIds.length > 0 && Object.keys(scores).length === 0) {
    return { ok: false, error: 'bad-response', detail: 'no usable answers in response' };
  }
  cooldownStep[provider] = RESTING_COOLDOWN_MS;
  return { ok: true, scores, tokens: adapter.inputTokens(json), model: adapter.model, complete };
}

export async function classifyPost(
  post: Post,
  questions: Record<string, string>,
  questionsKey: string,
): Promise<ClassifyResult> {
  const askedIds = Object.keys(questions);
  if (askedIds.length === 0) return { ok: true, scores: {}, tokens: 0 };

  const settings = await loadSettings();
  const key = activeKey(settings);
  if (key === '') return { ok: false, error: 'no-key', detail: '' };

  const contentKey = postContentKey(post);
  const cached = await cachedScores(post.id, settings.provider, questionsKey, contentKey);
  if (cached) {
    const { scores, complete } = filterScores(cached, askedIds);
    if (complete) return { ok: true, scores, tokens: 0 };
  }

  const cooling = coolingDown(settings.provider);
  if (cooling) return cooling;

  await acquire();
  try {
    const queuedBehindLimit = coolingDown(settings.provider);
    if (queuedBehindLimit) return queuedBehindLimit;
    const state = stateOf(post);
    const epoch = scoresEpoch();
    const outcome = await dedupe(
      requestKey(settings.provider, questionsKey, state, questions),
      () => runRequest(settings.provider, key, state, questions, askedIds),
    );
    if (!outcome.ok) return outcome;
    // Only cache a response that answered every question we asked, so partial
    // answers are retried instead of frozen in — and never after a data clear,
    // which would resurrect an answer the user asked to forget.
    if (outcome.complete && epoch === scoresEpoch()) {
      await rememberScores(post.id, settings.provider, questionsKey, contentKey, outcome.scores);
    }
    return { ok: true, scores: outcome.scores, tokens: outcome.tokens };
  } catch (error) {
    return {
      ok: false,
      error: 'network',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    release();
  }
}

/** One-off classification that shares the feed's concurrency gate and rate-limit
 * cooldown but never reads or writes the score cache. */
export async function classifyText(
  state: unknown,
  questions: Record<string, string>,
): Promise<TextOutcome> {
  const askedIds = Object.keys(questions);
  if (askedIds.length === 0) {
    return { ok: true, scores: {}, tokens: 0, model: '', complete: true };
  }

  const settings = await loadSettings();
  const key = activeKey(settings);
  if (key === '') return { ok: false, error: 'no-key', detail: '' };

  const cooling = coolingDown(settings.provider);
  if (cooling) return cooling;

  await acquire();
  try {
    const queuedBehindLimit = coolingDown(settings.provider);
    if (queuedBehindLimit) return queuedBehindLimit;
    return await dedupe(
      requestKey(settings.provider, '', state, questions),
      () => runRequest(settings.provider, key, state, questions, askedIds),
    );
  } catch (error) {
    return {
      ok: false,
      error: 'network',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    release();
  }
}