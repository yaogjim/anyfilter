import type { ProviderId } from '../../domain/provider';
import type { Scores } from '../../domain/verdict';

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Strictly-read response metadata. Every field is `undefined` when the provider
 * did not report a usable value; a missing or malformed field is never replaced
 * with a static default or a fabricated zero.
 */
export interface ProviderMetadata {
  /** The model the provider says actually answered, e.g. `jev-1.13.0` for
   * TypeSafe direct or `typesafe-ai/jev` for the AI Gateway. This is the
   * response's own value — never the adapter's requested model id. */
  model: string | undefined;
  /** Input tokens exactly as reported, or `undefined` when absent/invalid. */
  inputTokens: number | undefined;
  /** Output tokens exactly as reported, or `undefined` when absent/invalid. */
  outputTokens: number | undefined;
  /** Cost the AI Gateway reports for this response, in whole currency units
   * (its `providerMetadata.gateway.cost`, a decimal string such as
   * "0.00001155"). `undefined` for a provider that does not report cost, or when
   * the field is missing or malformed. The gateway's separate `marketCost`,
   * `surchargeCost` and `gatewayCost` figures are deliberately not conflated. */
  cost: number | undefined;
}

export interface ProviderAdapter {
  id: ProviderId;
  /** The model id this adapter *requests*. The model that actually answered is
   * read from the response via {@link ProviderAdapter.readMetadata}. */
  model: string;
  buildRequest(key: string, state: unknown, questions: Record<string, string>): ProviderRequest;
  parseScores(json: unknown): Scores;
  /** Legacy count: returns 0 when the field is missing. Kept unchanged so the
   * classifier's existing behaviour is preserved; use
   * {@link ProviderAdapter.readMetadata} for a strict value that tells "missing"
   * apart from zero. */
  inputTokens(json: unknown): number;
  /** Strictly reads the model that answered, token usage and gateway cost from
   * one response. Additive and read-only: it changes no existing parsing. */
  readMetadata(json: unknown): ProviderMetadata;
}

/** Coerces any response value into a record without assuming it is an object. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** A non-negative integer, or `undefined`. Floats, negatives, `NaN`, `Infinity`
 * and non-numbers are rejected rather than rounded or coerced into a number. */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A non-empty model id, or `undefined`. Surrounding whitespace is trimmed; a
 * blank or non-string model is "unknown", never the requested id. */
export function modelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A non-negative finite cost, accepting the decimal string the AI Gateway
 * returns (`"0.00001155"`) or an equivalent number. Anything else, including a
 * blank, negative or non-finite value, is `undefined`. */
export function costAmount(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Reads the response's top-level `model` under the strict rules above. */
export function readModel(json: unknown): string | undefined {
  return modelId(asRecord(json).model);
}

/** Reads the two token fields from a response's `usage` object under the names
 * the provider uses, so the two adapters cannot drift apart. */
export function readUsage(
  json: unknown,
  fields: { inputTokens: string; outputTokens: string },
): { inputTokens: number | undefined; outputTokens: number | undefined } {
  const usage = asRecord(asRecord(json).usage);
  return {
    inputTokens: tokenCount(usage[fields.inputTokens]),
    outputTokens: tokenCount(usage[fields.outputTokens]),
  };
}