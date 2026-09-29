import {
  JEV_1_13_MAX_INPUT_TOKENS,
  MICRO_PER_UNIT,
  type BudgetLimit,
  type BudgetPrice,
} from './evaluation-budget';

/**
 * The three labellers used by the real quality evaluation, each with the exact
 * model it is pinned to, the price it is reserved and settled at, and its own
 * currency cap.
 *
 * Pure data, no network. Every figure below was read from the provider's own
 * documentation on {@link PRICING_CHECKED_ON}; providers may change prices, so the
 * source page is kept next to each row and a person should re-read it before a
 * new run. Amounts are whole micro-units per million tokens (see
 * `evaluation-budget.ts`), so `$0.042 / Mtok` is `42_000`.
 *
 * Each model owns one price row and one cap row, so spend and reservations are
 * isolated per model and per currency: money spent on one model can never use up
 * another model's cap, and a model's currency cannot be reinterpreted.
 */

export const PRICING_CHECKED_ON = '2026-09-29';

export type LabellerId = 'jev' | 'openai' | 'deepseek';

export const LABELLER_IDS: readonly LabellerId[] = ['jev', 'openai', 'deepseek'];

export function isLabellerId(value: unknown): value is LabellerId {
  return value === 'jev' || value === 'openai' || value === 'deepseek';
}

export interface LabellerSpec {
  readonly id: LabellerId;
  readonly label: string;
  /** The exact model named in the request. Never a moving alias. */
  readonly model: string;
  readonly endpoint: string;
  readonly price: BudgetPrice;
  readonly limit: BudgetLimit;
  /** Output tokens the request is allowed to produce; reserved in full. */
  readonly maxOutputTokens: number;
  /** Documentation page the price and limits were read from. */
  readonly source: string;
  readonly note: string;
}

/**
 * Whole-request input ceiling for a labeller whose prompt this app builds
 * itself. A UTF-8 byte is never fewer than one token for a byte-level tokenizer,
 * so a prompt of at most `ceiling - PROMPT_OVERHEAD_TOKENS` bytes cannot exceed
 * `ceiling` tokens, whatever the tokenizer. The reservation is therefore a real
 * upper bound, not an estimate. Requests over it are refused before any network
 * call.
 */
export const OWN_PROMPT_MAX_INPUT_TOKENS = 16_384;

/** Slack for the per-message framing a provider adds around the prompt. */
export const PROMPT_OVERHEAD_TOKENS = 256;

/** A cap per model. It bounds real spend plus everything still reserved. */
const CAP_MICRO = MICRO_PER_UNIT;

export const JEV_SPEC: LabellerSpec = {
  id: 'jev',
  label: 'TypeSafe Jev 1.13',
  model: 'jev-1.13.0',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  price: { model: 'jev-1.13.0', currency: 'USD', inputMicroPerMTok: 42_000, outputMicroPerMTok: 0 },
  limit: {
    model: 'jev-1.13.0',
    currency: 'USD',
    capMicro: CAP_MICRO,
    maxInputTokens: JEV_1_13_MAX_INPUT_TOKENS,
  },
  maxOutputTokens: 256,
  source: 'https://docs.typesafe.ai/models',
  note: '$0.042 per million input tokens, output free; 64k tokens per request; 1,200 requests per minute.',
};

/** Where a machine labeller is reached and which model it is asked for. Both are
 * chosen by the person; the model must be one whose price is known here, so a
 * reservation is never made at a guessed rate. */
export interface LabellerConnection {
  readonly baseUrl: string;
  readonly model: string;
}

export type MachineConnectionId = Exclude<LabellerId, 'jev'>;

interface CatalogEntry {
  readonly labeller: MachineConnectionId;
  readonly label: string;
  readonly model: string;
  readonly price: BudgetPrice;
  readonly source: string;
  readonly note: string;
}

const CHAT_COMPLETIONS = '/chat/completions';

/** Every machine model that has a price row. The first entry of each labeller is
 * its default. */
export const MODEL_CATALOG: readonly CatalogEntry[] = [
  {
    labeller: 'openai',
    label: 'OpenAI GPT-6 Luna',
    model: 'gpt-6-luna',
    price: { model: 'gpt-6-luna', currency: 'USD', inputMicroPerMTok: 100_000, outputMicroPerMTok: 500_000 },
    source: 'https://developers.openai.com/api/docs/pricing',
    note: '$0.10 per million input tokens and $0.50 per million output tokens at standard short-context rates; reasoning tokens are billed as output, so reasoning is switched off.',
  },
  {
    labeller: 'openai',
    label: 'OpenAI GPT-6 Sol',
    model: 'gpt-6-sol',
    price: { model: 'gpt-6-sol', currency: 'USD', inputMicroPerMTok: 2_000_000, outputMicroPerMTok: 10_000_000 },
    source: 'https://developers.openai.com/api/docs/pricing',
    note: '$2.00 per million input tokens and $10.00 per million output tokens at standard short-context rates; reasoning is switched off. A relay may bill differently: the local cap uses these published rates.',
  },
  {
    labeller: 'deepseek',
    label: 'DeepSeek Flash',
    model: 'deepseek-flash',
    // Peak-hour cache-miss rates: the dearest the provider can charge, so the
    // reservation and the settled amount never fall below the real bill.
    price: { model: 'deepseek-flash', currency: 'USD', inputMicroPerMTok: 300_000, outputMicroPerMTok: 1_200_000 },
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    note: 'Peak rates are charged for every call: $0.30 per million input tokens (cache miss) and $1.20 per million output tokens; off-peak and cache hits only make it cheaper.',
  },
];

export const DEFAULT_CONNECTIONS: Readonly<Record<MachineConnectionId, LabellerConnection>> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
};

export function modelsOf(labeller: MachineConnectionId): readonly string[] {
  return MODEL_CATALOG.filter((entry) => entry.labeller === labeller).map((entry) => entry.model);
}

/** A base URL is `https`, has a host, no credentials, query or fragment, and is
 * stored without a trailing slash. Anything else is `null`. */
export function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The connection is valid when the URL is usable and the model has a price row. */
export function normalizeConnection(labeller: MachineConnectionId, raw: unknown): LabellerConnection | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const baseUrl = normalizeBaseUrl(record.baseUrl);
  if (baseUrl === null || typeof record.model !== 'string' || !modelsOf(labeller).includes(record.model)) return null;
  return { baseUrl, model: record.model };
}

export type EvaluationConnections = Readonly<Record<MachineConnectionId, LabellerConnection>>;

export function isEvaluationConnections(value: unknown): value is EvaluationConnections {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return normalizeConnection('openai', record.openai) !== null && normalizeConnection('deepseek', record.deepseek) !== null;
}

function machineSpec(labeller: MachineConnectionId, connection: LabellerConnection): LabellerSpec {
  const entry = MODEL_CATALOG.find((e) => e.labeller === labeller && e.model === connection.model);
  if (entry === undefined) throw new Error(`no price row for ${connection.model}`);
  return {
    id: labeller,
    label: entry.label,
    model: entry.model,
    endpoint: `${connection.baseUrl}${CHAT_COMPLETIONS}`,
    price: entry.price,
    limit: {
      model: entry.model,
      currency: entry.price.currency,
      capMicro: CAP_MICRO,
      maxInputTokens: OWN_PROMPT_MAX_INPUT_TOKENS,
    },
    maxOutputTokens: 256,
    source: entry.source,
    note: entry.note,
  };
}

/** The spec for one labeller under the connection the person configured. */
export function specWith(labeller: MachineConnectionId, connection: LabellerConnection): LabellerSpec {
  return machineSpec(labeller, connection);
}

export const OPENAI_SPEC: LabellerSpec = machineSpec('openai', DEFAULT_CONNECTIONS.openai);
export const DEEPSEEK_SPEC: LabellerSpec = machineSpec('deepseek', DEFAULT_CONNECTIONS.deepseek);

export const LABELLER_SPECS: Readonly<Record<LabellerId, LabellerSpec>> = {
  jev: JEV_SPEC,
  openai: OPENAI_SPEC,
  deepseek: DEEPSEEK_SPEC,
};

/** Which labeller answers to a model name, across every priced model. */
export function labellerOfModelName(model: string): LabellerId | null {
  if (model === JEV_SPEC.model) return 'jev';
  return MODEL_CATALOG.find((entry) => entry.model === model)?.labeller ?? null;
}

/** Human label for a priced model; the model name itself when it is unknown. */
export function labelOfModel(model: string): string {
  if (model === JEV_SPEC.model) return JEV_SPEC.label;
  return MODEL_CATALOG.find((entry) => entry.model === model)?.label ?? model;
}

/** Every price and cap row, for switching the budget on in one write. One row per
 * priced model, so spend on one model can never use another model's cap. */
export function budgetConfigOfAllLabellers(): {
  readonly prices: readonly BudgetPrice[];
  readonly limits: readonly BudgetLimit[];
} {
  const specs = [
    JEV_SPEC,
    ...MODEL_CATALOG.map((entry) => machineSpec(entry.labeller, { baseUrl: 'https://placeholder.invalid', model: entry.model })),
  ];
  return { prices: specs.map((spec) => spec.price), limits: specs.map((spec) => spec.limit) };
}

/** `true` when a fully built request body fits the labeller's input ceiling. A
 * body is the exact text that will be sent, so its UTF-8 length bounds its tokens. */
export function fitsInputCeiling(spec: LabellerSpec, requestBody: string): boolean {
  if (spec.id === 'jev') return true; // the provider enforces its own 64k ceiling
  const bytes = new TextEncoder().encode(requestBody).length;
  return bytes + PROMPT_OVERHEAD_TOKENS <= spec.limit.maxInputTokens;
}
