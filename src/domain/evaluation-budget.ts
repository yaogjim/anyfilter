import { hashString } from './rule';

/**
 * Phase 3 contract for a persistent, per-model spending budget on the
 * *verification* task only.
 *
 * This module is pure: no network, no provider key, no `chrome` access and no
 * model call. It decides how much money one verification job may reserve, when a
 * job may start at all, and how a job survives a background restart. It says
 * nothing about the normal feed: the feed's own Jev calls are not counted here
 * and must never be described as bounded by this budget.
 *
 * Money is kept as integer micro-units of one currency
 * ({@link MICRO_PER_UNIT} = one whole unit), so no floating point rounding can
 * lose or invent a cent. Every amount belongs to exactly one model and one
 * currency; a model whose price is not explicitly known can never be started.
 *
 * Prices are stated in whole micro-units per **million** tokens
 * ({@link TOKENS_PER_MTOK}), never per single token. Frontier input prices are
 * sub-micro per token — Jev 1.13 is $0.042 per million input tokens, i.e. 42,000
 * micro per million, or 0.042 micro per token — so a per-token integer unit
 * either cannot represent the price at all (fail-closed, unusable) or must round
 * it up to 1 micro per token, overcharging by ~23.8×. Costs are derived with a
 * ceiling, so a fraction of a micro-unit is charged as one whole unit and neither
 * the reservation nor the settled amount can ever fall below the real cost.
 *
 * A job's input side is reserved at the model's published whole-request token
 * ceiling ({@link BudgetLimit.maxInputTokens}), never at a count derived from the
 * text being sent. The visible text cannot bound the provider's hidden
 * instruction overhead, so a text-derived bound would understate the worst case
 * and let the cap be bypassed.
 *
 * A model may be named by an alias (Jev's `jev-latest` resolves to
 * `jev-1.13.0`). Because an alias can be repointed or repriced, each reservation
 * stores the exact rates it was made under and settles at those rates, so a later
 * price edit cannot rewrite what an already-reserved job owes. Spend is accounted
 * per model name, so a repointed alias is a separate bucket rather than a silent
 * widening of an existing cap.
 *
 * The state is a pure data record: persistence lives in
 * `infrastructure/evaluation-jobs.ts`, which owns exactly one `storage.local`
 * key and never reads or writes the settings, the panel state, the capture
 * library or the score cache.
 */

/** Micro-units per whole currency unit, so every amount is an exact integer. */
export const MICRO_PER_UNIT = 1_000_000;

/**
 * Tokens per million tokens (one "Mtok"): the denominator of the
 * {@link BudgetPrice} rates. A rate of `42000` means 42,000 micro-units of the
 * currency for every 1,000,000 tokens.
 */
export const TOKENS_PER_MTOK = 1_000_000;

/**
 * Published whole-request input ceiling for TypeSafe Jev 1.13 — the model behind
 * `jev-1.13.0` and its `jev-latest` / `jev-preview` aliases.
 *
 * The provider's model page states "64k tokens per request; 32k tokens for
 * `state` plus the longest question", and a request above the limit is refused.
 * 65,536 is therefore the largest number of input tokens one accepted request
 * can be charged for. It is the provider's own ceiling, which already includes
 * the instruction/system overhead that a byte count of the visible `state` and
 * question cannot see (a short official question still reports 296 input
 * tokens). It is deliberately **not** derived from the text being sent.
 *
 * Source: https://docs.typesafe.ai/models (checked 2026-09-28). The provider
 * reserves the right to change limits without notice, so a run may declare a
 * larger ceiling; it must never declare a smaller one for this model.
 */
export const JEV_1_13_MAX_INPUT_TOKENS = 65_536;

/** Hard cap on stored jobs, so the state can never grow without bound. */
export const MAX_JOBS = 400;
/** Settled jobs are kept for audit but shed oldest-first; pending and unknown
 * jobs are never shed, because they still hold money. */
export const MAX_SETTLED_JOBS = 200;

/** One known price for one model. Both rates are required and non-negative, and
 * they must be stated in the currency of the matching limit.
 *
 * A rate is whole micro-units of the currency per **million** tokens
 * ({@link TOKENS_PER_MTOK}), not per single token. Jev 1.13's verified input
 * price of $0.042 per million tokens is therefore `42000` here, and its free
 * output is `0`. */
export interface BudgetPrice {
  readonly model: string;
  readonly currency: string;
  readonly inputMicroPerMTok: number;
  readonly outputMicroPerMTok: number;
}

/** The explicit per-model, per-currency ceiling for one run. A model without a
 * limit row cannot be started, because an unbounded call is exactly what this
 * budget exists to prevent. */
export interface BudgetLimit {
  readonly model: string;
  readonly currency: string;
  readonly capMicro: number;
  /**
   * The whole-request input-token ceiling reserved before every call, taken from
   * the provider's published context limit (see
   * {@link JEV_1_13_MAX_INPUT_TOKENS}). It is required: a limit row without it is
   * refused, so a byte count or any other text-derived guess can never stand in
   * for a verified ceiling and silently under-reserve.
   */
  readonly maxInputTokens: number;
}

/** `pending` holds a reservation; `settled` records what was really spent;
 * `unknown` means the request was sent (or may have been sent) and no answer was
 * recorded. An `unknown` job keeps its reservation, because the provider may
 * already have charged it. */
export type EvaluationJobStatus = 'pending' | 'settled' | 'unknown';

/**
 * The real judgement recorded with a settled job, or `null` when only money and
 * usage were recorded. `decided` carries the provider's finite 0..1 probability;
 * whether it was a match is derived from {@link EvaluationJob.threshold}, so the
 * two can never drift apart. `undecided` is a paid call that produced no usable
 * answer — it is never a silent negative.
 *
 * A job whose `verdict` is `null` — whether it never settled or settled without a
 * recorded answer — must never be presented as a baseline: "money was spent" and
 * "we know what the model answered" are deliberately separate facts.
 */
export type JobVerdict =
  | { readonly status: 'decided'; readonly score: number }
  | { readonly status: 'undecided' }
  /** A model that gives a state and a reason instead of a probability (the two
   * independent labellers). `state` is that model's own answer, including its own
   * "undecided"; the reason is a short clipped sentence, never the post text. A
   * paid call with no readable answer is plain `undecided`, not this. */
  | {
      readonly status: 'labelled';
      readonly state: 'match' | 'no-match' | 'undecided';
      readonly reason: string;
    };

/** Longest reason kept with a labelled verdict. */
export const MAX_LABEL_REASON_LENGTH = 280;

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Strict read of an untrusted verdict record. Anything that is not an explicit
 * `undecided` or a finite 0..1 `decided` score is `null` (no result), never a
 * fabricated probability. */
export function normalizeJobVerdict(raw: unknown): JobVerdict | null {
  const record = asRecord(raw);
  if (record.status === 'undecided') return { status: 'undecided' };
  if (record.status === 'decided' && isProbability(record.score)) {
    return { status: 'decided', score: record.score };
  }
  if (
    record.status === 'labelled' &&
    (record.state === 'match' || record.state === 'no-match' || record.state === 'undecided') &&
    typeof record.reason === 'string'
  ) {
    return {
      status: 'labelled',
      state: record.state,
      reason: record.reason.trim().slice(0, MAX_LABEL_REASON_LENGTH),
    };
  }
  return null;
}

/** One verification task: one rule, one model, one exact input, and — once it has
 * settled — the trusted real judgement for that input. The stored record carries
 * only identity and outcome: `sampleId`, `ruleId`, the input and rules
 * fingerprints, the threshold, the score or `undecided`, the response model and
 * the real token usage. It never stores the body text or a key, so the baseline
 * can be restored from `storage.local` without re-reading or re-sending content. */
export interface EvaluationJob {
  /** Deterministic identity, from {@link jobIdFor}; a repeat is the same task. */
  readonly jobId: string;
  /** The stored capture sample this job judged, or `null` when it was reserved by
   * a caller that did not name one. Set at start and never overwritten by a later
   * settle with a different id. */
  readonly sampleId: string | null;
  readonly model: string;
  readonly currency: string;
  /** The rates this job was reserved under, in micro-units per million tokens.
   * Settlement charges these exact rates, so a later price edit can never change
   * what an old job already owes and can never quietly shrink its recorded cost. */
  readonly inputMicroPerMTok: number;
  readonly outputMicroPerMTok: number;
  readonly rulesFingerprint: string;
  readonly ruleId: string;
  readonly inputHash: string;
  /** The `rule.threshold ?? settings.threshold` the answer is compared against,
   * or `null` when it was never recorded. Kept with the score so a restored
   * baseline reproduces the exact match/no-match decision. */
  readonly threshold: number | null;
  /** The model's whole-request input ceiling reserved before the call, not an
   * estimate of the text that was sent. */
  readonly reservedInputTokens: number;
  /** Upper bound on output tokens the call was allowed to produce. */
  readonly maxOutputTokens: number;
  /** Worst-case money held for this job. Kept after settling for audit. */
  readonly reservedMicro: number;
  /** Real money recorded at settle time; `null` while not settled. */
  readonly settledMicro: number | null;
  readonly settledInputTokens: number | null;
  readonly settledOutputTokens: number | null;
  /** The model the response reported, or `null` when it was never recorded. */
  readonly answeredModel: string | null;
  /** The real judgement recorded in the same write as the money, or `null` when
   * none was recorded (not settled, or settled without a result). */
  readonly verdict: JobVerdict | null;
  readonly status: EvaluationJobStatus;
  /** The run this job belongs to. A settle carrying another epoch is refused. */
  readonly epoch: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Everything the budget persists. `enabled` is `false` until an explicit user
 * action, and only `true` literally is ever read back as enabled. */
export interface EvaluationJobState {
  readonly enabled: boolean;
  /** Bumped by stop and by delete, so a late answer from before either one is
   * refused instead of being written. */
  readonly epoch: number;
  readonly prices: readonly BudgetPrice[];
  readonly limits: readonly BudgetLimit[];
  /** Real spend already recorded, per model. Kept across stop and delete: money
   * that was spent does not come back. */
  readonly spentMicro: Readonly<Record<string, number>>;
  readonly jobs: readonly EvaluationJob[];
  readonly updatedAt: number;
}

export function emptyJobState(): EvaluationJobState {
  return { enabled: false, epoch: 0, prices: [], limits: [], spentMicro: {}, jobs: [], updatedAt: 0 };
}

/** Why a budget operation was refused. Every reason is local and offline. */
export type BudgetRefusal =
  | 'disabled'
  | 'price-unknown'
  | 'limit-unknown'
  | 'currency-mismatch'
  | 'cap-exceeded'
  | 'job-limit'
  | 'invalid'
  | 'not-found'
  | 'stale-epoch';

export interface BudgetRefusalResult {
  readonly ok: false;
  readonly error: BudgetRefusal;
  readonly detail: string;
}

export interface BudgetStateResult {
  readonly ok: true;
  readonly state: EvaluationJobState;
}

export interface StartJobResult {
  readonly ok: true;
  readonly state: EvaluationJobState;
  readonly job: EvaluationJob;
  /** `true` when the identical task was already recorded: nothing new was
   * reserved and no new call should be made. */
  readonly deduped: boolean;
}

export interface UpdateJobResult {
  readonly ok: true;
  readonly state: EvaluationJobState;
  readonly job: EvaluationJob;
  readonly deduped: boolean;
  /** `true` when the job no longer holds a reservation. */
  readonly released: boolean;
}

function refusal(error: BudgetRefusal, detail: string): BudgetRefusalResult {
  return { ok: false, error, detail };
}

export function formatMicro(micro: number, currency: string): string {
  const sign = micro < 0 ? '-' : '';
  const abs = Math.abs(micro);
  const units = Math.floor(abs / MICRO_PER_UNIT);
  const fraction = String(abs % MICRO_PER_UNIT).padStart(6, '0');
  return `${sign}${currency} ${units}.${fraction}`;
}

const CURRENCY = /^[A-Z]{3}$/;

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return isNonNegativeInt(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Strict price validation: a half-stated price is treated as no price at all,
 * so an unknown rate can never be silently read as zero. Rates are micro-units
 * per million tokens. */
export function normalizePrice(raw: unknown): BudgetPrice | null {
  const record = asRecord(raw);
  const { model, currency, inputMicroPerMTok, outputMicroPerMTok } = record;
  if (typeof model !== 'string' || model === '') return null;
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return null;
  if (!isNonNegativeInt(inputMicroPerMTok) || !isNonNegativeInt(outputMicroPerMTok)) return null;
  if (inputMicroPerMTok === 0 && outputMicroPerMTok === 0) return null;
  return { model, currency, inputMicroPerMTok, outputMicroPerMTok };
}

/** Strict limit validation: the cap must be a positive integer, so `0` or a
 * missing cap is refused rather than read as "unlimited". The verified input
 * ceiling is required too, so a run can never start without a reservable input
 * bound. */
export function normalizeLimit(raw: unknown): BudgetLimit | null {
  const record = asRecord(raw);
  const { model, currency, capMicro, maxInputTokens } = record;
  if (typeof model !== 'string' || model === '') return null;
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return null;
  if (!isPositiveInt(capMicro)) return null;
  if (!isPositiveInt(maxInputTokens)) return null;
  return { model, currency, capMicro, maxInputTokens };
}

function normalizeJob(
  raw: unknown,
  epoch: number,
  prices: readonly BudgetPrice[],
): EvaluationJob | null {
  const record = asRecord(raw);
  const {
    jobId,
    sampleId,
    model,
    currency,
    inputMicroPerMTok,
    outputMicroPerMTok,
    rulesFingerprint,
    ruleId,
    inputHash,
    threshold,
    reservedInputTokens,
    maxOutputTokens,
    reservedMicro,
    settledMicro,
    settledInputTokens,
    settledOutputTokens,
    answeredModel,
    status,
    createdAt,
    updatedAt,
  } = record;
  if (typeof jobId !== 'string' || jobId === '') return null;
  if (typeof model !== 'string' || model === '') return null;
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return null;
  if (typeof rulesFingerprint !== 'string' || typeof ruleId !== 'string') return null;
  if (typeof inputHash !== 'string' || inputHash === '') return null;
  if (!isNonNegativeInt(reservedInputTokens) || !isPositiveInt(maxOutputTokens)) return null;
  if (!isNonNegativeInt(reservedMicro)) return null;
  // The job's own rates are authoritative. A record written before they were
  // stored is repaired from the model's price; a job that cannot be priced at
  // all is dropped rather than settled against an invented rate.
  const price = resolvePrice(prices, model);
  const inputRate = isNonNegativeInt(inputMicroPerMTok)
    ? inputMicroPerMTok
    : (price?.inputMicroPerMTok ?? null);
  const outputRate = isNonNegativeInt(outputMicroPerMTok)
    ? outputMicroPerMTok
    : (price?.outputMicroPerMTok ?? null);
  if (inputRate === null || outputRate === null) return null;
  if (inputRate === 0 && outputRate === 0) return null;
  if (status !== 'pending' && status !== 'settled' && status !== 'unknown') return null;
  if (status === 'settled') {
    if (!isNonNegativeInt(settledMicro)) return null;
    if (!isNonNegativeInt(settledInputTokens) || !isNonNegativeInt(settledOutputTokens)) return null;
  } else if (settledMicro !== null || settledInputTokens !== null || settledOutputTokens !== null) {
    return null;
  }
  // A settled job with an unreadable verdict keeps its money and its usage but is
  // recorded as settled-without-result, so a corrupted answer can never be
  // presented as a baseline. A non-settled job can never carry a verdict.
  const settled = status === 'settled';
  const verdict = settled ? normalizeJobVerdict(record.verdict) : null;
  const resolvedThreshold =
    typeof threshold === 'number' && isProbability(threshold) ? threshold : null;
  const resolvedSampleId = typeof sampleId === 'string' && sampleId !== '' ? sampleId : null;
  const resolvedAnsweredModel =
    typeof answeredModel === 'string' && answeredModel !== '' ? answeredModel : null;
  const jobEpoch = isNonNegativeInt(record.epoch) ? record.epoch : epoch;
  return {
    jobId,
    sampleId: resolvedSampleId,
    model,
    currency,
    inputMicroPerMTok: inputRate,
    outputMicroPerMTok: outputRate,
    rulesFingerprint,
    ruleId,
    inputHash,
    threshold: resolvedThreshold,
    reservedInputTokens,
    maxOutputTokens,
    reservedMicro,
    settledMicro: settled ? (settledMicro as number) : null,
    settledInputTokens: settled ? (settledInputTokens as number) : null,
    settledOutputTokens: settled ? (settledOutputTokens as number) : null,
    answeredModel: settled ? resolvedAnsweredModel : null,
    verdict,
    status,
    epoch: jobEpoch,
    createdAt: isNonNegativeInt(createdAt) ? createdAt : 0,
    updatedAt: isNonNegativeInt(updatedAt) ? updatedAt : 0,
  };
}

/** Lenient read of a stored record. Anything unrecognized falls back to the
 * empty, disabled state, so a corrupted record can never switch the budget on,
 * invent a price, or report money as reserved. */
export function normalizeJobState(raw: unknown): EvaluationJobState {
  const record = asRecord(raw);
  if (typeof raw !== 'object' || raw === null) return emptyJobState();
  const epoch = isNonNegativeInt(record.epoch) ? record.epoch : 0;
  const prices: BudgetPrice[] = [];
  if (Array.isArray(record.prices)) {
    for (const candidate of record.prices) {
      const price = normalizePrice(candidate);
      if (price && !prices.some((existing) => existing.model === price.model)) prices.push(price);
    }
  }
  const limits: BudgetLimit[] = [];
  if (Array.isArray(record.limits)) {
    for (const candidate of record.limits) {
      const limit = normalizeLimit(candidate);
      if (limit && !limits.some((existing) => existing.model === limit.model)) limits.push(limit);
    }
  }
  const spentMicro: Record<string, number> = {};
  const rawSpent = asRecord(record.spentMicro);
  for (const [model, amount] of Object.entries(rawSpent)) {
    if (model !== '' && isNonNegativeInt(amount)) spentMicro[model] = amount;
  }
  const jobs: EvaluationJob[] = [];
  if (Array.isArray(record.jobs)) {
    for (const candidate of record.jobs) {
      const job = normalizeJob(candidate, epoch, prices);
      if (job && !jobs.some((existing) => existing.jobId === job.jobId)) jobs.push(job);
    }
  }
  return {
    enabled: record.enabled === true,
    epoch,
    prices,
    limits,
    spentMicro,
    jobs,
    updatedAt: isNonNegativeInt(record.updatedAt) ? record.updatedAt : 0,
  };
}

export function isJobState(value: unknown): value is EvaluationJobState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.enabled === 'boolean' &&
    isNonNegativeInt(record.epoch) &&
    Array.isArray(record.prices) &&
    Array.isArray(record.limits) &&
    typeof record.spentMicro === 'object' &&
    record.spentMicro !== null &&
    Array.isArray(record.jobs)
  );
}

/*
 * Input tokens reserved for one call.
 *
 * The reservation is the model's published whole-request ceiling
 * ({@link BudgetLimit.maxInputTokens}), never a count derived from the text. A
 * UTF-8 byte length is **not** a token count: it cannot see the provider's own
 * instruction/system overhead — a single short question still reports 296 input
 * tokens — so treating it as an upper bound would let the worst case be
 * understated by orders of magnitude and the cap be bypassed.
 */

function ceilDiv(numerator: number, denominator: number): number | null {
  if (!isNonNegativeInt(numerator) || !isPositiveInt(denominator)) return null;
  const adjusted = numerator + (denominator - 1);
  if (!Number.isSafeInteger(adjusted)) return null;
  return Math.floor(adjusted / denominator);
}

/** Micro-units owed for `tokens` at `microPerMTok`, rounded **up** to a whole
 * micro-unit so a fractional micro can never be dropped. `null` when the
 * arithmetic overflows or a rate is unusable. */
function costMicro(tokens: number, microPerMTok: number): number | null {
  if (!isNonNegativeInt(tokens) || !isNonNegativeInt(microPerMTok)) return null;
  const scaled = tokens * microPerMTok;
  if (!Number.isSafeInteger(scaled)) return null;
  return ceilDiv(scaled, TOKENS_PER_MTOK);
}

/** Money for one call: the input bound plus the declared output bound, both at
 * the model's own per-million-token rates and both rounded up to a whole
 * micro-unit. The ceiling is what keeps the held money — and the settled cost
 * computed by the same function — from ever falling below the real cost. `null`
 * means the arithmetic overflows or the price is not usable, and the job must not
 * start. */
export function reservationMicro(
  price: BudgetPrice,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const input = costMicro(inputTokens, price.inputMicroPerMTok);
  const output = costMicro(outputTokens, price.outputMicroPerMTok);
  if (input === null || output === null) return null;
  const total = input + output;
  return Number.isSafeInteger(total) ? total : null;
}

export function resolvePrice(prices: readonly BudgetPrice[], model: string): BudgetPrice | null {
  return prices.find((price) => price.model === model) ?? null;
}

export function resolveLimit(limits: readonly BudgetLimit[], model: string): BudgetLimit | null {
  return limits.find((limit) => limit.model === model) ?? null;
}

/** Money still held for one model: pending and unknown jobs only. A settled job
 * has already been charged to {@link EvaluationJobState.spentMicro} instead. */
export function reservedMicroOf(state: EvaluationJobState, model: string): number {
  let total = 0;
  for (const job of state.jobs) {
    if (job.model !== model) continue;
    if (job.status === 'pending' || job.status === 'unknown') total += job.reservedMicro;
  }
  return total;
}

export function spentMicroOf(state: EvaluationJobState, model: string): number {
  return state.spentMicro[model] ?? 0;
}

/** The currency a model still holds money in when it differs from `next`, or
 * `null` when nothing conflicts.
 *
 * The stored jobs are read first and carry their own currency, so a held amount
 * stays visible even after its price and limit rows have been deleted: deleting
 * the rows and re-adding the model in another currency cannot launder the
 * reservation into a different unit. Recorded spend has no currency of its own,
 * so it is checked against whatever rows remain. */
function heldMoneyCurrency(state: EvaluationJobState, model: string, next: string): string | null {
  for (const job of state.jobs) {
    if (job.model === model && job.currency !== next) return job.currency;
  }
  if (spentMicroOf(state, model) > 0) {
    const previous = resolvePrice(state.prices, model)?.currency
      ?? resolveLimit(state.limits, model)?.currency
      ?? null;
    if (previous && previous !== next) return previous;
  }
  return null;
}

/** How much more may still be reserved for this model, or `null` when the model
 * has no explicit cap and therefore may not be started at all. */
export function availableMicroOf(state: EvaluationJobState, model: string): number | null {
  const limit = resolveLimit(state.limits, model);
  if (!limit) return null;
  return limit.capMicro - spentMicroOf(state, model) - reservedMicroOf(state, model);
}

/** Identity of one verification task. Two requests with the same model, rule set,
 * rule and input are the same task, so the second one never pays twice. */
export function jobIdFor(
  model: string,
  rulesFingerprint: string,
  ruleId: string,
  inputHash: string,
): string {
  return `job.${hashString(JSON.stringify([model, rulesFingerprint, ruleId, inputHash]))}`;
}

/** The exact work a job would do.
 *
 * `maxOutputTokens` is the bound the real request must enforce; it is required
 * so the reservation can never be smaller than what the call is allowed to
 * produce. The input side is not passed as text: the reservation uses the
 * model's published whole-request ceiling from its limit row, because no
 * text-derived count can bound the provider's hidden instruction overhead. */
export interface StartJobRequest {
  readonly model: string;
  readonly rulesFingerprint: string;
  readonly ruleId: string;
  readonly inputHash: string;
  readonly maxOutputTokens: number;
  /** The stored capture sample this job judges. Optional so the budget can still
   * be exercised without a sample; it is persisted when present. */
  readonly sampleId?: string;
  /** The threshold the answer will be compared against, persisted so a restored
   * baseline reproduces the same match/no-match decision. */
  readonly threshold?: number;
}

function pruneSettled(jobs: readonly EvaluationJob[]): EvaluationJob[] {
  const settled = jobs.filter((job) => job.status === 'settled');
  if (settled.length <= MAX_SETTLED_JOBS) return [...jobs];
  const drop = new Set(settled.slice(0, settled.length - MAX_SETTLED_JOBS).map((job) => job.jobId));
  return jobs.filter((job) => !drop.has(job.jobId));
}

function markUnsettledUnknown(jobs: readonly EvaluationJob[], now: number): EvaluationJob[] {
  return jobs.map((job) =>
    job.status === 'pending' ? { ...job, status: 'unknown' as const, updatedAt: now } : job,
  );
}

/**
 * Turns the budget on with an explicit price table and per-model caps.
 *
 * Every limit must name a model with a known price in the same currency, so the
 * budget can never be enabled with an unpriced rate: an unknown price is refused
 * here rather than discovered after a paid call.
 *
 * A model may be named by exactly one price row and exactly one limit row. A
 * duplicate is refused instead of silently letting the first row win, because a
 * second, looser row would otherwise widen the cap or cheapen the rate without
 * the caller noticing. A model's currency may not change while it still has
 * money recorded or reserved, so an amount is never reinterpreted in a currency
 * it was not spent in. That protection is read from the stored jobs too, so
 * deleting a model's rows and re-adding it in another currency is still refused.
 */
export function enableBudget(
  state: EvaluationJobState,
  config: { readonly prices: readonly BudgetPrice[]; readonly limits: readonly BudgetLimit[] },
  now = 0,
): BudgetStateResult | BudgetRefusalResult {
  const prices: BudgetPrice[] = [];
  for (const raw of config.prices) {
    const price = normalizePrice(raw);
    if (!price) return refusal('invalid', 'a price row is malformed or has no usable rate');
    if (prices.some((existing) => existing.model === price.model)) {
      return refusal('invalid', `more than one price row names ${price.model}`);
    }
    prices.push(price);
  }
  const limits: BudgetLimit[] = [];
  for (const raw of config.limits) {
    const limit = normalizeLimit(raw);
    if (!limit) return refusal('invalid', 'a limit row is malformed or has no positive cap');
    if (limits.some((existing) => existing.model === limit.model)) {
      return refusal('invalid', `more than one limit row names ${limit.model}`);
    }
    limits.push(limit);
  }
  if (limits.length === 0) {
    return refusal('invalid', 'a budget needs at least one per-model currency limit');
  }
  for (const limit of limits) {
    const price = resolvePrice(prices, limit.model);
    if (!price) return refusal('price-unknown', `no known price for ${limit.model}`);
    if (price.currency !== limit.currency) {
      return refusal(
        'currency-mismatch',
        `${limit.model} is priced in ${price.currency} but capped in ${limit.currency}`,
      );
    }
  }
  for (const model of new Set([...prices.map((price) => price.model), ...limits.map((limit) => limit.model)])) {
    const next = resolvePrice(prices, model)?.currency ?? resolveLimit(limits, model)?.currency ?? null;
    if (!next) continue;
    const held = heldMoneyCurrency(state, model, next);
    if (held) {
      return refusal(
        'currency-mismatch',
        `${model} still holds money in ${held}; its currency cannot become ${next}`,
      );
    }
  }
  return { ok: true, state: { ...state, enabled: true, prices, limits, updatedAt: now } };
}

/**
 * Stops the run. Every still-open job becomes `unknown` and keeps its
 * reservation, because a request that was already sent may already have been
 * charged; the epoch is bumped so an answer that arrives after the stop can no
 * longer be written. Recorded spend is left untouched.
 */
export function disableBudget(state: EvaluationJobState, now = 0): EvaluationJobState {
  return {
    ...state,
    enabled: false,
    epoch: state.epoch + 1,
    jobs: markUnsettledUnknown(state.jobs, now),
    updatedAt: now,
  };
}

/**
 * Reserves the worst case for one job and records it as `pending`.
 *
 * The input side reserves the model's whole-request token ceiling from its limit
 * row, so the reservation covers the provider's hidden instruction overhead and
 * any tokenizer, never just the visible text.
 *
 * Refused, in order: when the identical task is already recorded (which is a
 * successful dedupe, not an error — nothing new is reserved and nothing new may
 * be sent), when the budget is off, when the price is unknown, when the model has
 * no cap, when currencies disagree, and when the worst case would exceed the cap.
 */
export function startJob(
  state: EvaluationJobState,
  request: StartJobRequest,
  now = 0,
): StartJobResult | BudgetRefusalResult {
  const jobId = jobIdFor(request.model, request.rulesFingerprint, request.ruleId, request.inputHash);
  const existing = state.jobs.find((job) => job.jobId === jobId);
  if (existing) return { ok: true, state, job: existing, deduped: true };

  if (!state.enabled) return refusal('disabled', 'the verification budget is off');
  if (!isPositiveInt(request.maxOutputTokens)) {
    return refusal('invalid', 'maxOutputTokens must be a positive integer');
  }
  const price = resolvePrice(state.prices, request.model);
  if (!price) return refusal('price-unknown', `no known price for ${request.model}`);
  const limit = resolveLimit(state.limits, request.model);
  if (!limit) return refusal('limit-unknown', `no currency cap for ${request.model}`);
  if (limit.currency !== price.currency) {
    return refusal(
      'currency-mismatch',
      `${request.model} is priced in ${price.currency} but capped in ${limit.currency}`,
    );
  }

  const reservedInputTokens = limit.maxInputTokens;
  const reserved = reservationMicro(price, reservedInputTokens, request.maxOutputTokens);
  if (reserved === null) return refusal('invalid', 'the worst-case reservation is out of range');

  const remaining = limit.capMicro - spentMicroOf(state, request.model) - reservedMicroOf(state, request.model);
  if (reserved > remaining) {
    return refusal(
      'cap-exceeded',
      `reserving ${formatMicro(reserved, price.currency)} would exceed the remaining ${formatMicro(
        Math.max(0, remaining),
        price.currency,
      )} for ${request.model}`,
    );
  }

  const jobs = pruneSettled(state.jobs);
  if (jobs.length >= MAX_JOBS) {
    return refusal('job-limit', `${MAX_JOBS} jobs are already recorded`);
  }

  const job: EvaluationJob = {
    jobId,
    sampleId: typeof request.sampleId === 'string' && request.sampleId !== '' ? request.sampleId : null,
    model: request.model,
    currency: price.currency,
    inputMicroPerMTok: price.inputMicroPerMTok,
    outputMicroPerMTok: price.outputMicroPerMTok,
    rulesFingerprint: request.rulesFingerprint,
    ruleId: request.ruleId,
    inputHash: request.inputHash,
    threshold:
      request.threshold !== undefined && isProbability(request.threshold) ? request.threshold : null,
    reservedInputTokens,
    maxOutputTokens: request.maxOutputTokens,
    reservedMicro: reserved,
    settledMicro: null,
    settledInputTokens: null,
    settledOutputTokens: null,
    answeredModel: null,
    verdict: null,
    status: 'pending',
    epoch: state.epoch,
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, state: { ...state, jobs: [...jobs, job], updatedAt: now }, job, deduped: false };
}

/** What a completed call actually used, and the trusted judgement it produced.
 * The identity and outcome fields are optional so a caller that only reconciles
 * spend can still settle; when they are supplied they are written in the same
 * single `storage.local` transaction as the money, so a settled job can never
 * hold a cost without also holding (or explicitly lacking) its real answer. */
export interface SettleJobRequest {
  readonly jobId: string;
  /** The epoch the caller started under; a mismatch means the answer is late. */
  readonly epoch: number;
  readonly actualInputTokens: number;
  readonly actualOutputTokens: number;
  /** The stored capture sample this answer belongs to. Persisted when present. */
  readonly sampleId?: string;
  /** The threshold the score is compared against. Persisted when present. */
  readonly threshold?: number;
  /** The model the response reported, or omitted/null when it reported none. */
  readonly answeredModel?: string | null;
  /** The trusted real judgement: a finite 0..1 score or an explicit undecided. */
  readonly verdict?: JobVerdict;
}

/**
 * Records real usage, releases the reservation and adds the real cost to the
 * model's spent total.
 *
 * The cost is charged at the rates the job was reserved under, never at whatever
 * the price table says now: re-pricing a model after the fact must not be able to
 * shrink (or inflate) what an already-reserved call owes. An answer carrying
 * another epoch is refused, so a response that arrives after a stop, a clear or a
 * delete can never be written. Settling an already-settled job is an idempotent
 * dedupe. Real usage above the reservation is recorded as it is instead of being
 * clamped: the reservation is a ceiling that proved too low, and hiding that
 * would understate the cost.
 */
export function settleJob(
  state: EvaluationJobState,
  request: SettleJobRequest,
  now = 0,
): UpdateJobResult | BudgetRefusalResult {
  if (request.epoch !== state.epoch) {
    return refusal('stale-epoch', `epoch ${request.epoch} is not the current epoch ${state.epoch}`);
  }
  const index = state.jobs.findIndex((job) => job.jobId === request.jobId);
  if (index < 0) return refusal('not-found', `no job ${request.jobId}`);
  const job = state.jobs[index];
  if (job.status === 'settled') return { ok: true, state, job, deduped: true, released: true };

  const actual = reservationMicro(
    {
      model: job.model,
      currency: job.currency,
      inputMicroPerMTok: job.inputMicroPerMTok,
      outputMicroPerMTok: job.outputMicroPerMTok,
    },
    request.actualInputTokens,
    request.actualOutputTokens,
  );
  if (actual === null) return refusal('invalid', 'the recorded usage is out of range');

  // The verdict travels with the money in the same write. A caller may leave it
  // out (spend-only reconciliation), but a supplied verdict must be real, and a
  // settled job that never recorded one stays settled-without-result rather than
  // being read as a baseline.
  let verdict = job.verdict;
  if (request.verdict !== undefined) {
    const normalized = normalizeJobVerdict(request.verdict);
    if (normalized === null) {
      return refusal('invalid', 'the verdict is not a finite 0..1 score, a labelled answer or undecided');
    }
    verdict = normalized;
  }
  let sampleId = job.sampleId;
  if (request.sampleId !== undefined) {
    if (typeof request.sampleId !== 'string' || request.sampleId === '') {
      return refusal('invalid', 'the sample id is empty');
    }
    sampleId = request.sampleId;
  }
  let threshold = job.threshold;
  if (request.threshold !== undefined) {
    if (!isProbability(request.threshold)) {
      return refusal('invalid', 'the threshold is not a finite 0..1 number');
    }
    threshold = request.threshold;
  }
  const answeredModel =
    request.answeredModel === undefined
      ? job.answeredModel
      : typeof request.answeredModel === 'string' && request.answeredModel !== ''
        ? request.answeredModel
        : null;

  const settled: EvaluationJob = {
    ...job,
    sampleId,
    threshold,
    answeredModel,
    verdict,
    settledMicro: actual,
    settledInputTokens: request.actualInputTokens,
    settledOutputTokens: request.actualOutputTokens,
    status: 'settled',
    updatedAt: now,
  };
  const jobs = pruneSettled(state.jobs.map((candidate, at) => (at === index ? settled : candidate)));
  return {
    ok: true,
    state: {
      ...state,
      spentMicro: { ...state.spentMicro, [job.model]: spentMicroOf(state, job.model) + actual },
      jobs,
      updatedAt: now,
    },
    job: settled,
    deduped: false,
    released: true,
  };
}

export interface AbandonJobRequest {
  readonly jobId: string;
  readonly epoch: number;
  /** Whether the request had already been sent when the job was given up. */
  readonly sent: boolean;
}

/**
 * Gives up on one job without an answer.
 *
 * `sent: false` means the call was never made, so the job is deleted and its
 * reservation is released. `sent: true` means the provider may already have
 * charged the call: the job becomes `unknown` and **keeps** its reservation, and
 * it is never retried on its own — a retry would be a second paid call for work
 * that may already have succeeded. A job that is already `unknown` is never
 * released, even when reported as unsent: it may already have been charged, so
 * its reservation stays held until a person reconciles it.
 */
export function abandonJob(
  state: EvaluationJobState,
  request: AbandonJobRequest,
  now = 0,
): UpdateJobResult | BudgetRefusalResult {
  if (request.epoch !== state.epoch) {
    return refusal('stale-epoch', `epoch ${request.epoch} is not the current epoch ${state.epoch}`);
  }
  const index = state.jobs.findIndex((job) => job.jobId === request.jobId);
  if (index < 0) return refusal('not-found', `no job ${request.jobId}`);
  const job = state.jobs[index];
  if (job.status === 'settled') return { ok: true, state, job, deduped: true, released: true };
  // An unknown job may already have been charged. An `unsent` report cannot be
  // trusted to refund it, and re-abandoning must not change it: the reservation
  // stays held until a person explicitly reconciles the job.
  if (job.status === 'unknown') {
    return { ok: true, state, job, deduped: false, released: false };
  }

  if (!request.sent) {
    return {
      ok: true,
      state: { ...state, jobs: state.jobs.filter((_, at) => at !== index), updatedAt: now },
      job,
      deduped: false,
      released: true,
    };
  }
  const unknown: EvaluationJob = { ...job, status: 'unknown', updatedAt: now };
  return {
    ok: true,
    state: {
      ...state,
      jobs: state.jobs.map((candidate, at) => (at === index ? unknown : candidate)),
      updatedAt: now,
    },
    job: unknown,
    deduped: false,
    released: false,
  };
}

/**
 * Background-start recovery: every job still open becomes `unknown`, keeping its
 * reservation. A worker that was killed mid-request cannot know whether the
 * provider charged it, so the honest state is `unknown` and the money stays held
 * until a person reconciles it. Nothing is re-sent here.
 */
export function recoverUnsettledJobs(
  state: EvaluationJobState,
  now = 0,
): { state: EvaluationJobState; recovered: number } {
  const recovered = state.jobs.filter((job) => job.status === 'pending').length;
  if (recovered === 0) return { state, recovered: 0 };
  return {
    state: { ...state, jobs: markUnsettledUnknown(state.jobs, now), updatedAt: now },
    recovered,
  };
}

/**
 * Clears the *settled* history and bumps the epoch, so an answer that arrives for
 * a job from before the clear is refused instead of landing.
 *
 * Jobs that still hold money — `pending` and `unknown` — are kept. A request that
 * may already have been charged cannot be forgotten: dropping it would free its
 * reservation, let the cap be used a second time, and let the identical task be
 * started and paid for again. Keeping the job also keeps its identity, so a
 * repeat is still recognised as the same task rather than a new one. Recorded
 * spend and the price table are kept too: deleting history cannot un-spend money,
 * and the cap must stay honest.
 */
export function clearJobHistory(state: EvaluationJobState, now = 0): EvaluationJobState {
  return {
    ...state,
    jobs: state.jobs.filter((job) => job.status !== 'settled'),
    epoch: state.epoch + 1,
    updatedAt: now,
  };
}

/** Total money still held across every model. */
export function outstandingMicroOf(state: EvaluationJobState): number {
  let total = 0;
  for (const job of state.jobs) {
    if (job.status === 'pending' || job.status === 'unknown') total += job.reservedMicro;
  }
  return total;
}

/** Open jobs, for a status list. `unknown` is a real state to show, not an
 * error to swallow. */
export function openJobs(state: EvaluationJobState): readonly EvaluationJob[] {
  return state.jobs.filter((job) => job.status !== 'settled');
}

/**
 * A settled job's real judgement, restored from `storage.local` without touching
 * the network, the capture body or a key. This is what a restarted worker reads
 * to recover a Jev baseline that would otherwise be lost with the in-memory
 * result.
 *
 * It carries only the recorded identity and outcome, never the sample body or the
 * request. `verdict` is present by construction, so a caller can never mistake a
 * spend-only record for a real answer.
 */
export interface SettledEvaluationBaseline {
  readonly jobId: string;
  readonly sampleId: string;
  readonly ruleId: string;
  readonly model: string;
  readonly rulesFingerprint: string;
  readonly inputHash: string;
  readonly threshold: number;
  readonly verdict: JobVerdict;
  readonly answeredModel: string | null;
  readonly settledInputTokens: number;
  readonly settledOutputTokens: number;
  readonly settledMicro: number;
  readonly updatedAt: number;
}

/**
 * The restorable baseline of one job, or `null` when there is something to
 * restore from. A job that is not settled, or is settled without a recorded
 * verdict, or lacks a sample id or threshold, yields `null`: `settled-without-
 * result` is a held cost, not a baseline, and must never be presented as one.
 */
export function settledBaselineOf(job: EvaluationJob): SettledEvaluationBaseline | null {
  if (job.status !== 'settled') return null;
  if (job.verdict === null) return null;
  if (job.sampleId === null || job.sampleId === '') return null;
  if (job.threshold === null) return null;
  if (job.settledInputTokens === null || job.settledOutputTokens === null || job.settledMicro === null) {
    return null;
  }
  return {
    jobId: job.jobId,
    sampleId: job.sampleId,
    ruleId: job.ruleId,
    model: job.model,
    rulesFingerprint: job.rulesFingerprint,
    inputHash: job.inputHash,
    threshold: job.threshold,
    verdict: job.verdict,
    answeredModel: job.answeredModel,
    settledInputTokens: job.settledInputTokens,
    settledOutputTokens: job.settledOutputTokens,
    settledMicro: job.settledMicro,
    updatedAt: job.updatedAt,
  };
}

/** Every restorable baseline in the state, in stored order. Settled-without-
 * result and open jobs are skipped rather than guessed at. */
export function settledBaselines(state: EvaluationJobState): readonly SettledEvaluationBaseline[] {
  const baselines: SettledEvaluationBaseline[] = [];
  for (const job of state.jobs) {
    const baseline = settledBaselineOf(job);
    if (baseline) baselines.push(baseline);
  }
  return baselines;
}