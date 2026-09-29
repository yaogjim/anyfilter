import { senderKind, type SenderLike } from '../domain/capture';
import type { EvaluationJobState } from '../domain/evaluation-budget';
import {
  budgetStatusOf,
  candidatesOf,
  sampleDetailOf,
  type VerificationBudgetStatus,
  type VerificationCandidate,
  type VerificationDetailResult,
  type VerificationEnableResult,
  type VerificationRunResult,
  type VerificationStopResult,
} from '../domain/evaluation-verification';
import type { Rule } from '../domain/rule';
import type { Settings } from '../domain/settings';
import { loadCaptureSamples } from './capture-store';
import { JEV_MODEL, enableEvaluationBudgets, runSingleSampleEvaluation } from './evaluation-jev';
import { disableEvaluationBudget, loadEvaluationJobs } from './evaluation-jobs';
import { loadSettings } from './settings-store';

/**
 * The authorization boundary for the manual, single-sample verification entry
 * point, and the only place a real paid call can be triggered from the UI.
 *
 * Two rules are enforced here rather than promised anywhere else:
 *
 * - **Only our own extension pages may ask.** Every entry point takes the raw
 *   `chrome.runtime.MessageSender` and re-derives who sent it with
 *   `senderKind`. A content script running in an X tab, a web page, or another
 *   extension is refused before any key is read, any sample is loaded and any
 *   budget row is written. The panel's click is trusted only because the sender
 *   proves it is our own page.
 * - **Authorization is derived, never accepted.** `runSingleSampleEvaluation`
 *   requires `authorized: true`, and the literal below is the only place that
 *   flag is produced. No message field can set it, so nothing that can reach the
 *   background can turn a refusal into a call.
 *
 * The call itself stays pinned: the model, the price, the cap and the endpoint
 * all come from the already-built execution slice, and this module adds no way to
 * name any of them.
 */

/** Reads the shared spending picture. Any extension context may read it. */
export function verificationStatusOf(state: EvaluationJobState): VerificationBudgetStatus {
  return budgetStatusOf(state, JEV_MODEL);
}

export async function loadVerificationStatus(): Promise<VerificationBudgetStatus> {
  return verificationStatusOf(await loadEvaluationJobs());
}

/**
 * Reads the local candidate list. It is a projection of the stored samples: only
 * the excerpt, the truncation flag and an identifiable source leave this call, so
 * the panel never holds the captured `stateJson`.
 */
export async function loadVerificationCandidates(): Promise<VerificationCandidate[]> {
  return candidatesOf(await loadCaptureSamples());
}

function enabledSemanticRule(settings: Settings, ruleId: string): Rule | undefined {
  return settings.rules.find(
    (rule) => rule.id === ruleId && rule.enabled && rule.kind === 'semantic',
  );
}

/** Refusal text, stated the same way for both entry points. */
function wrongSenderDetail(kind: string): string {
  return `verification may only be started from this extension's own pages, not from a ${kind} sender`;
}

/**
 * Reads the exact stored text of one sample for the trusted side panel.
 *
 * This is the only place a captured body is handed to a page, and it is bounded
 * on purpose:
 *
 * - **Our own page only.** A content script, a web page or another extension is
 *   refused with no body and no partial read.
 * - **Strict identity.** The lookup is an exact `sampleId` equality over the
 *   stored samples; there is no prefix match, no index and no fuzzy lookup, so a
 *   lookalike id cannot read a neighbour's body.
 * - **Local only.** It reads `storage.local` and returns a projection. It logs
 *   nothing, reaches no network, writes no store and never reads a key, so the
 *   body cannot leak through a log line or a request.
 */
export async function loadVerificationSampleDetail(
  sender: SenderLike,
  ownExtensionId: string,
  sampleId: string,
): Promise<VerificationDetailResult> {
  const kind = senderKind(sender, ownExtensionId);
  if (kind !== 'extension-page') {
    return { ok: false, reason: 'wrong-sender', message: wrongSenderDetail(kind) };
  }
  const samples = await loadCaptureSamples();
  const sample = samples.find((candidate) => candidate.sampleId === sampleId);
  if (sample === undefined) {
    return { ok: false, reason: 'sample-not-found', message: 'the sample is no longer stored' };
  }
  const projected = sampleDetailOf(sample);
  if (projected === null) {
    return { ok: false, reason: 'unreadable', message: 'the stored sample state cannot be read as text' };
  }
  return { ok: true, sample: projected };
}

/**
 * Switches the verification budget on with the pinned Jev 1.13 price and the
 * USD 1 cap. A refusal (wrong sender, or a budget that cannot be priced) is
 * reported together with the *unchanged* status, so the panel can never display a
 * state that does not hold.
 */
export async function enableVerificationBudget(
  sender: SenderLike,
  ownExtensionId: string,
): Promise<VerificationEnableResult> {
  const kind = senderKind(sender, ownExtensionId);
  if (kind !== 'extension-page') {
    return {
      ok: false,
      detail: wrongSenderDetail(kind),
      status: await loadVerificationStatus(),
    };
  }
  const result = await enableEvaluationBudgets();
  if (result.ok) return { ok: true, detail: '', status: verificationStatusOf(result.state) };
  return { ok: false, detail: result.detail, status: await loadVerificationStatus() };
}

/**
 * Switches the verification budget off with the explicit stop the panel offers.
 *
 * This is the only way to stop spending, and it refuses any sender that is not
 * one of our own pages before anything is written. It delegates to the existing
 * store stop, which persists the state, marks every still-open job `unknown` and
 * keeps that job's reservation, and bumps the epoch so an answer that arrives
 * after the stop can no longer be written.
 *
 * What a stop does and does not do, stated plainly because the panel repeats it:
 * new requests are refused while the budget is off; a request that was already
 * sent may still be charged, so an unknown reservation is never refunded here. No
 * key is read and no network is reached.
 */
export async function disableVerificationBudget(
  sender: SenderLike,
  ownExtensionId: string,
): Promise<VerificationStopResult> {
  const kind = senderKind(sender, ownExtensionId);
  if (kind !== 'extension-page') {
    return {
      ok: false,
      detail: wrongSenderDetail(kind),
      status: await loadVerificationStatus(),
    };
  }
  const result = await disableEvaluationBudget();
  if (result.ok) return { ok: true, detail: '', status: verificationStatusOf(result.state) };
  return { ok: false, detail: result.detail, status: await loadVerificationStatus() };
}

/**
 * Runs exactly one stored sample against exactly one enabled semantic rule.
 *
 * Order: sender, then the rule, then the pinned execution slice (which itself
 * re-checks the key, the sample, its local admissibility, the persisted
 * reservation and the fail-closed activity recheck before `fetch`). Nothing here
 * loops over samples or retries, and a refusal never releases held money.
 */
export async function runVerificationSample(
  sender: SenderLike,
  ownExtensionId: string,
  sampleId: string,
  ruleId: string,
): Promise<VerificationRunResult> {
  const kind = senderKind(sender, ownExtensionId);
  if (kind !== 'extension-page') {
    return { kind: 'skipped', sampleId, ruleId, reason: 'wrong-sender', detail: wrongSenderDetail(kind) };
  }
  const settings = await loadSettings();
  if (enabledSemanticRule(settings, ruleId) === undefined) {
    return {
      kind: 'skipped',
      sampleId,
      ruleId,
      reason: 'rule-not-compiled',
      detail: 'only an enabled semantic rule can be verified',
    };
  }
  return runSingleSampleEvaluation({ sampleId, ruleId, authorized: true });
}