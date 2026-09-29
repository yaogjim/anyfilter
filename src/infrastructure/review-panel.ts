import type { ReviewSnapshot } from '../domain/review';
import {
  draftProblem,
  MAX_NO_RULE_REASON_LENGTH,
  type DraftProblem,
  type ReviewActionResult,
  type ReviewDraft,
  type ReviewOverall,
  type ReviewRecord,
} from '../domain/review-record';
import type { TranslationKey } from '../ui/i18n';
import { CURRENT_ATTRIBUTE, HOST_ATTRIBUTE } from './review-dom';
import type { ReviewLayer } from './review-layer';

const PANEL_HOST = 'panel';
/** Panel width and its gap to the post, in CSS pixels. */
const PANEL_WIDTH = 340;
const PANEL_GAP = 12;
const PANEL_MARGIN = 8;
const OVERALLS: readonly ReviewOverall[] = ['hide', 'keep', 'uncertain'];

const OVERALL_KEY: Record<ReviewOverall, TranslationKey> = {
  hide: 'review.post.hide',
  keep: 'review.post.keep',
  uncertain: 'review.post.uncertain',
};

const HINT_KEY: Record<ReviewOverall | 'none', TranslationKey> = {
  none: 'review.post.hintNone',
  hide: 'review.post.hintHide',
  keep: 'review.post.hintKeep',
  uncertain: 'review.post.hintUncertain',
};

const PROBLEM_KEY: Record<DraftProblem, TranslationKey> = {
  'no-overall': 'review.post.problem.noOverall',
  'no-rule-or-reason': 'review.post.problem.noRule',
  'reason-empty': 'review.post.problem.reasonEmpty',
  'reason-too-long': 'review.post.problem.reasonTooLong',
};

const ERROR_KEY: Record<string, TranslationKey> = {
  'stale-epoch': 'review.error.stale',
  full: 'review.error.full',
  'too-long': 'review.error.tooLong',
  invalid: 'review.error.invalid',
  storage: 'review.error.storage',
  'wrong-sender': 'review.error.sender',
  'no-input': 'review.error.noInput',
};

interface OpenPanel {
  article: HTMLElement;
  snapshot: ReviewSnapshot;
  host: HTMLElement;
  draft: MutableDraft;
  busy: boolean;
  /** Set after a failed attempt to save, so the reason is shown. */
  showProblem: boolean;
  status: string;
  /** An edit arrived while a save was running; save again when it finishes. */
  dirty: boolean;
  /** The draft as last read from the stored label; while the draft still equals it,
   * a label stored elsewhere (a one-click verdict) is adopted. */
  baseline: string;
}

interface MutableDraft {
  overall: ReviewOverall | null;
  ruleIds: Set<string>;
  noRuleCovers: boolean;
  reason: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function draftOf(record: ReviewRecord | undefined): MutableDraft {
  return {
    overall: record?.overall ?? null,
    ruleIds: new Set(record?.rules.map((tag) => tag.ruleId) ?? []),
    noRuleCovers: record?.noRuleCovers !== undefined,
    reason: record?.noRuleCovers ?? '',
  };
}

function draftKey(draft: MutableDraft): string {
  return JSON.stringify([draft.overall, [...draft.ruleIds].sort(), draft.noRuleCovers, draft.reason.trim()]);
}

function toDraft(draft: MutableDraft): ReviewDraft {
  return {
    overall: draft.overall,
    ruleIds: [...draft.ruleIds],
    noRuleCovers: draft.noRuleCovers,
    reason: draft.reason,
  };
}

/**
 * The single-post review panel: shows every rule's score and threshold and lets
 * the person record a judgement. It floats to the right of the post (fixed to the
 * window, following the post while the page scrolls), so it adds no height to the
 * feed and stays clear of X's like, repost and reply buttons.
 *
 * A label counts as saved only after the annotation store confirmed it. A failed
 * save keeps what was entered and can be retried.
 */
export class ReviewPanel {
  private open: OpenPanel | null = null;

  private readonly layer: ReviewLayer;
  private frame = 0;
  private readonly onMove = (): void => this.schedulePlace();

  constructor(layer: ReviewLayer) {
    this.layer = layer;
  }

  /** Puts the panel beside its post: to the right when there is room, else to the
   * left, else pinned to the window edge. The top follows the post but stays inside
   * the window. A post scrolled fully out of view hides the panel until it returns. */
  private place(): void {
    const open = this.open;
    if (!open) return;
    if (!open.article.isConnected) {
      this.close(false);
      return;
    }
    const post = open.article.getBoundingClientRect();
    const width = open.host.offsetWidth || PANEL_WIDTH;
    const height = open.host.offsetHeight || 320;
    const viewWidth = document.documentElement.clientWidth;
    const viewHeight = window.innerHeight;
    let left = post.right + PANEL_GAP;
    if (left + width > viewWidth - PANEL_MARGIN) {
      const beside = post.left - PANEL_GAP - width;
      left = beside >= PANEL_MARGIN ? beside : Math.max(PANEL_MARGIN, viewWidth - width - PANEL_MARGIN);
    }
    const top = Math.min(Math.max(post.top, PANEL_MARGIN), Math.max(PANEL_MARGIN, viewHeight - height - PANEL_MARGIN));
    open.host.style.left = `${Math.round(left)}px`;
    open.host.style.top = `${Math.round(top)}px`;
    open.host.style.visibility = post.bottom < 0 || post.top > viewHeight ? 'hidden' : 'visible';
  }

  private schedulePlace(): void {
    if (this.frame !== 0) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.place();
    });
  }

  toggle(article: HTMLElement, snapshot: ReviewSnapshot): void {
    if (this.open?.article === article) {
      this.close(true);
      return;
    }
    this.openFor(article, snapshot);
  }

  /** Opens the panel for a post and applies what a one-click verdict handed over:
   * a verdict to start from, or the reason a quick save failed. */
  openWith(
    article: HTMLElement,
    snapshot: ReviewSnapshot,
    start: { overall?: ReviewOverall; error?: string },
  ): void {
    if (this.open?.article !== article) this.openFor(article, snapshot);
    const open = this.open;
    if (!open) return;
    if (start.overall !== undefined && open.draft.overall !== start.overall) {
      this.chooseOverall(open, start.overall);
    }
    if (start.error !== undefined) {
      open.status = this.layer.t(ERROR_KEY[start.error] ?? 'review.error.storage');
    }
    this.update();
  }

  private openFor(article: HTMLElement, snapshot: ReviewSnapshot): void {
    this.close(false);
    const record = this.layer.annotationPort()?.recordFor(snapshot);
    const host = document.createElement('div');
    host.setAttribute(HOST_ATTRIBUTE, PANEL_HOST);
    host.attachShadow({ mode: 'open' });
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'keyup', 'keypress'] as const) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }
    host.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') this.close(true);
    });
    host.style.cssText = 'position:fixed;z-index:2147483000;left:0;top:0;';
    document.body.append(host);
    window.addEventListener('scroll', this.onMove, { capture: true, passive: true });
    window.addEventListener('resize', this.onMove);
    this.open = {
      article,
      snapshot,
      host,
      draft: draftOf(record),
      busy: false,
      showProblem: false,
      status: '',
      dirty: false,
      baseline: draftKey(draftOf(record)),
    };
    this.layer.labelOf(article)?.setAttribute('aria-expanded', 'true');
    article.setAttribute(CURRENT_ATTRIBUTE, '');
    this.build();
    host.shadowRoot?.querySelector<HTMLElement>('.panel')?.focus({ preventScroll: true });
  }

  /** Closes the panel when it belongs to `sampleId` (a collapse, or a node that
   * now shows another post). */
  closeFor(sampleId: string): void {
    if (this.open?.snapshot.sampleId === sampleId) this.close(false);
  }

  closeAll(): void {
    this.close(false);
  }

  /** The post under an open panel was judged again. */
  snapshotChanged(article: HTMLElement, snapshot: ReviewSnapshot): void {
    const open = this.open;
    if (!open || open.article !== article) return;
    if (open.snapshot.sampleId !== snapshot.sampleId) {
      this.close(false);
      return;
    }
    const shape = (item: ReviewSnapshot): string =>
      JSON.stringify([item.state, item.direct, item.undecidedReason, item.rules]);
    const changed = shape(open.snapshot) !== shape(snapshot);
    open.snapshot = snapshot;
    if (changed) this.build();
  }

  /** A label was stored or removed: refresh what the open panel shows. */
  sync(): void {
    const open = this.open;
    if (!open) return;
    const record = this.layer.annotationPort()?.recordFor(open.snapshot);
    if (draftKey(open.draft) === open.baseline) {
      open.draft = draftOf(record);
      open.baseline = draftKey(open.draft);
    }
    this.update();
  }

  relocalize(): void {
    if (this.open) this.build();
  }

  private close(returnFocus: boolean): void {
    const open = this.open;
    if (!open) return;
    this.open = null;
    window.removeEventListener('scroll', this.onMove, { capture: true });
    window.removeEventListener('resize', this.onMove);
    if (this.frame !== 0) {
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    open.host.remove();
    open.article.removeAttribute(CURRENT_ATTRIBUTE);
    const label = this.layer.labelOf(open.article);
    label?.setAttribute('aria-expanded', 'false');
    if (returnFocus) label?.focus();
  }

  // ---------------------------------------------------------------- building

  private refs: {
    hint: HTMLElement;
    verdicts: Map<ReviewOverall, HTMLButtonElement>;
    rules: Map<string, HTMLInputElement>;
    noCoverRow: HTMLElement;
    noCover: HTMLInputElement;
    reason: HTMLInputElement;
    reasonLabel: HTMLElement;
    problem: HTMLElement;
    save: HTMLButtonElement;
    valuable: HTMLButtonElement;
    undo: HTMLButtonElement;
    collapse: HTMLButtonElement;
    status: HTMLElement;
  } | null = null;

  private build(): void {
    const open = this.open;
    const root = open?.host.shadowRoot;
    if (!open || !root) return;
    const t = this.layer.t;
    const style = document.createElement('style');
    style.textContent = PANEL_STYLES;

    const panel = el('div', 'panel');
    panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'title');

    const head = el('div', 'head');
    const title = el('strong', 'title', t('review.post.title'));
    title.id = 'title';
    const chip = el('span', 'chip', this.stateLine(open.snapshot));
    chip.dataset.state = open.snapshot.state;
    const close = el('button', 'x', '×');
    close.type = 'button';
    close.title = t('review.post.close');
    close.setAttribute('aria-label', t('review.post.close'));
    close.addEventListener('click', () => this.close(true));
    head.append(title, chip, close);

    const verdictGroup = el('div', 'verdicts');
    verdictGroup.setAttribute('role', 'group');
    verdictGroup.setAttribute('aria-label', t('review.post.judgement'));
    const verdicts = new Map<ReviewOverall, HTMLButtonElement>();
    for (const overall of OVERALLS) {
      const button = el('button', 'verdict', t(OVERALL_KEY[overall]));
      button.type = 'button';
      button.dataset.verdict = overall;
      button.addEventListener('click', () => {
        if (open.draft.overall !== overall) this.chooseOverall(open, overall);
        this.changed();
      });
      verdicts.set(overall, button);
      verdictGroup.append(button);
    }

    const hint = el('p', 'hint');
    const rulesBox = el('div', 'rules');
    rulesBox.setAttribute('role', 'group');
    rulesBox.setAttribute('aria-label', t('review.post.rulesHeading'));
    const rules = new Map<string, HTMLInputElement>();
    if (open.snapshot.rules.length === 0) {
      rulesBox.append(el('p', 'hint wide', t('review.post.noRules')));
    }
    for (const rule of open.snapshot.rules) {
      const row = el('label', 'rule');
      row.title = this.layer.ruleText(rule);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = open.draft.ruleIds.has(rule.ruleId);
      box.addEventListener('change', () => {
        if (open.draft.overall === null) {
          // Ticking a rule before choosing a verdict means "this rule applies".
          this.chooseOverall(open, 'hide');
        }
        if (box.checked) open.draft.ruleIds.add(rule.ruleId);
        else open.draft.ruleIds.delete(rule.ruleId);
        if (box.checked) {
          open.draft.noRuleCovers = false;
          open.draft.reason = '';
        }
        this.changed();
      });
      rules.set(rule.ruleId, box);
      // The full "score (threshold)" sentence sits in the tooltip and the accessible
      // name; the row itself only shows the rule and its score.
      const score = rule.local ? (rule.hit ? '●' : '–') : rule.score === null ? '–' : `${Math.round(rule.score * 100)}%`;
      row.setAttribute('aria-label', this.layer.ruleText(rule));
      row.append(box, el('span', rule.hit ? 'name hit' : 'name', rule.label), el('span', rule.hit ? 'score hit' : 'score', score));
      rulesBox.append(row);
    }

    const noCoverRow = el('div', 'nocover');
    const noCoverLabel = el('label', 'rule wide');
    const noCover = document.createElement('input');
    noCover.type = 'checkbox';
    noCover.addEventListener('change', () => {
      open.draft.noRuleCovers = noCover.checked;
      if (noCover.checked) open.draft.ruleIds.clear();
      this.changed();
    });
    noCoverLabel.append(noCover, el('span', 'name', t('review.post.noRuleCovers')));
    const reasonLabel = el('label', 'reason-label');
    const reason = document.createElement('input');
    reason.type = 'text';
    reason.maxLength = MAX_NO_RULE_REASON_LENGTH + 40;
    reason.placeholder = t('review.post.reason');
    reason.setAttribute('aria-label', t('review.post.reason'));
    reason.addEventListener('input', () => {
      open.draft.reason = reason.value;
      open.showProblem = false;
      this.update();
    });
    // The sentence is stored when the person finishes it (Enter or leaving the box).
    reason.addEventListener('change', () => this.changed());
    reason.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.changed();
    });
    reasonLabel.append(reason);
    noCoverRow.append(noCoverLabel, reasonLabel);

    const problem = el('p', 'problem');
    problem.setAttribute('role', 'alert');

    const actions = el('div', 'actions');
    // Every other choice is stored as soon as it is complete; only the free-text
    // reason needs an explicit save.
    const save = el('button', 'primary', t('review.post.save'));
    save.type = 'button';
    save.addEventListener('click', () => void this.save(true));
    const valuable = el('button', 'toggle');
    valuable.type = 'button';
    valuable.addEventListener('click', () => void this.toggleValuable());
    const undo = el('button', 'plain', t('review.post.undo'));
    undo.type = 'button';
    undo.addEventListener('click', () => void this.undo());
    const collapse = el('button', 'plain', t('review.post.collapse'));
    collapse.type = 'button';
    collapse.addEventListener('click', () => this.layer.setCollapsed(open.snapshot, true));
    actions.append(save, valuable, undo, collapse);

    const status = el('p', 'status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const note = el('p', 'foot', t('review.post.assisted'));

    panel.append(head, verdictGroup, hint, rulesBox, noCoverRow, problem, actions, status, note);
    root.replaceChildren(style, panel);
    this.refs = { hint, verdicts, rules, noCoverRow, noCover, reason, reasonLabel, problem, save, valuable, undo, collapse, status };
    this.update();
  }

  private stateLine(snapshot: ReviewSnapshot): string {
    const t = this.layer.t;
    const text = this.layer.stateText(snapshot);
    if (snapshot.state === 'undecided' && snapshot.undecidedReason) {
      return `${text} · ${t(`review.undecided.${snapshot.undecidedReason}`)}`;
    }
    return text;
  }

  /** Brings every dynamic part of the open panel in line with the draft and the
   * stored annotation, without rebuilding (which would drop focus). */
  private update(): void {
    const open = this.open;
    const refs = this.refs;
    if (!open || !refs) return;
    const t = this.layer.t;
    const record = this.layer.annotationPort()?.recordFor(open.snapshot);
    const overall = open.draft.overall;
    for (const [value, button] of refs.verdicts) {
      button.setAttribute('aria-pressed', String(overall === value));
    }
    refs.hint.textContent = t(HINT_KEY[overall ?? 'none']);
    for (const [ruleId, box] of refs.rules) {
      box.checked = open.draft.ruleIds.has(ruleId);
      box.disabled = open.draft.noRuleCovers;
    }
    refs.noCoverRow.hidden = overall !== 'hide';
    refs.noCover.checked = open.draft.noRuleCovers;
    refs.reasonLabel.hidden = !open.draft.noRuleCovers;
    if (refs.reason.value !== open.draft.reason) refs.reason.value = open.draft.reason;
    const problem = draftProblem(toDraft(open.draft));
    refs.problem.textContent = open.showProblem && problem ? t(PROBLEM_KEY[problem]) : '';
    refs.save.hidden = !open.draft.noRuleCovers;
    refs.save.disabled = open.busy;
    refs.valuable.disabled = open.busy;
    refs.valuable.setAttribute('aria-pressed', String(record?.valuable === true));
    refs.valuable.textContent = t(record?.valuable ? 'review.post.unvaluable' : 'review.post.valuable');
    refs.undo.hidden = !(record && record.overall !== null);
    refs.undo.disabled = open.busy;
    refs.collapse.disabled = open.busy;
    refs.status.textContent = open.status;
    // Rows appear and disappear as the verdict changes, so the height moves.
    this.place();
  }

  // ----------------------------------------------------------------- actions

  private async run(work: () => Promise<ReviewActionResult>, done: TranslationKey): Promise<boolean> {
    const open = this.open;
    if (!open) return false;
    const t = this.layer.t;
    open.busy = true;
    open.status = t('review.post.saving');
    this.update();
    let result: ReviewActionResult;
    try {
      result = await work();
    } catch {
      result = { ok: false, error: 'storage' };
    }
    // The panel may have been closed or moved to another post meanwhile.
    if (this.open !== open) return result.ok;
    open.busy = false;
    open.status = result.ok ? t(done) : t(ERROR_KEY[result.error] ?? 'review.error.storage');
    this.update();
    if (open.dirty) {
      // Something was ticked while this save ran: store the newer state too.
      open.dirty = false;
      if (result.ok) void this.save(false);
    }
    return result.ok;
  }

  /** Picks a verdict. Ticks never carry over between verdicts, because what a tick
   * means depends on the verdict; a hide verdict starts from the rules the model hit. */
  private chooseOverall(open: OpenPanel, overall: ReviewOverall): void {
    open.draft.ruleIds.clear();
    open.draft.noRuleCovers = false;
    open.draft.reason = '';
    if (overall === 'hide') {
      for (const rule of open.snapshot.rules) if (rule.hit) open.draft.ruleIds.add(rule.ruleId);
    }
    open.draft.overall = overall;
  }

  /** The draft was edited: store it as soon as it is complete. An edit that leaves
   * an already stored label incomplete says so instead of silently keeping the old one. */
  private changed(): void {
    const open = this.open;
    const port = this.layer.annotationPort();
    if (!open || !port) return;
    const problem = draftProblem(toDraft(open.draft));
    const record = port.recordFor(open.snapshot);
    open.showProblem = problem !== null && record?.overall != null;
    open.status = '';
    this.update();
    if (problem === null) void this.save(false);
  }

  /** Stores the draft. `force` also stores an unchanged draft and reports what is
   * missing when it is incomplete (the explicit Save button). */
  private async save(force: boolean): Promise<void> {
    const open = this.open;
    const port = this.layer.annotationPort();
    if (!open || !port) return;
    if (draftProblem(toDraft(open.draft)) !== null) {
      if (force) {
        open.showProblem = true;
        this.update();
      }
      return;
    }
    if (open.busy) {
      open.dirty = true;
      return;
    }
    const record = port.recordFor(open.snapshot);
    if (!force && record && draftKey(draftOf(record)) === draftKey(open.draft)) return;
    const snapshot = open.snapshot;
    await this.run(() => port.saveDraft(snapshot, toDraft(open.draft)), 'review.post.saved');
  }

  private async toggleValuable(): Promise<void> {
    const open = this.open;
    const port = this.layer.annotationPort();
    if (!open || !port || open.busy) return;
    const snapshot = open.snapshot;
    const next = port.recordFor(snapshot)?.valuable !== true;
    await this.run(() => port.setValuable(snapshot, next), 'review.post.saved');
  }

  private async undo(): Promise<void> {
    const open = this.open;
    const port = this.layer.annotationPort();
    if (!open || !port || open.busy) return;
    const snapshot = open.snapshot;
    const ok = await this.run(() => port.removeLabel(snapshot), 'review.post.removed');
    if (ok && this.open === open) {
      open.draft = draftOf(port.recordFor(snapshot));
      this.update();
    }
  }
}

const PANEL_STYLES = `
  :host { all: initial; display: block; width: ${PANEL_WIDTH}px; max-width: calc(100vw - ${PANEL_MARGIN * 2}px); }
  .panel { box-sizing: border-box; padding: 10px 12px 8px; border-radius: 12px; max-height: calc(100vh - ${PANEL_MARGIN * 2}px);
    overflow: auto; background: #fff; color: #0f1419; border: 1px solid #cfd9de; font: 500 12.5px/1.4 system-ui, sans-serif;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18); }
  .panel:focus-visible { outline: 2px solid #1d9bf0; }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .title { font-size: 13px; }
  .chip { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px;
    color: #536471; }
  .chip::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%;
    background: #8b98a5; }
  .chip[data-state="kept"]::before { background: #1a7f45; }
  .chip[data-state="flagged"]::before { background: #b4472f; }
  .chip[data-state="undecided"]::before { background: #c99700; }
  .x { width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%; background: transparent; font-size: 18px;
    line-height: 1; color: #536471; }
  .verdicts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
  .verdict { padding: 5px 0; border-radius: 8px; }
  .verdict[aria-pressed="true"] { color: #fff; border-color: transparent; }
  .verdict[data-verdict="hide"][aria-pressed="true"] { background: #b4472f; }
  .verdict[data-verdict="keep"][aria-pressed="true"] { background: #1a7f45; }
  .verdict[data-verdict="uncertain"][aria-pressed="true"] { background: #8a6d00; }
  .hint { margin: 6px 0 4px; color: #536471; font-size: 11.5px; }
  .hint.wide { grid-column: 1 / -1; }
  .rules { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; margin: 0 0 4px; }
  .rule { display: flex; align-items: center; gap: 5px; min-width: 0; padding: 3px 0; cursor: pointer; }
  .rule input { margin: 0; flex: none; }
  .rule .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rule .score { flex: none; color: #8b98a5; font-variant-numeric: tabular-nums; font-size: 11.5px; }
  .rule .hit { color: #b4472f; font-weight: 700; }
  .nocover { margin: 2px 0 0; padding-top: 4px; border-top: 1px dashed #cfd9de; }
  .nocover .rule { padding: 2px 0; }
  .reason-label { display: block; margin-top: 3px; }
  .reason-label input { display: block; box-sizing: border-box; width: 100%; padding: 4px 8px; border: 1px solid #cfd9de;
    border-radius: 8px; font: inherit; color: #0f1419; }
  .problem { margin: 4px 0 0; color: #b4472f; font-size: 11.5px; }
  .problem:empty, .status:empty { display: none; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 8px; }
  .status { margin: 4px 0 0; font-size: 11.5px; color: #1a7f45; }
  .foot { margin: 6px 0 0; color: #8b98a5; font-size: 10.5px; }
  button { font: inherit; cursor: pointer; border-radius: 999px; padding: 4px 11px; border: 1px solid #cfd9de;
    background: #fff; color: #0f1419; }
  button:hover:not(:disabled) { background: #eff3f4; }
  button:disabled { opacity: 0.55; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid #1d9bf0; outline-offset: 2px; }
  button.primary { background: #1d9bf0; color: #fff; border-color: #1d9bf0; font-weight: 700; padding: 4px 14px; }
  button.primary:hover:not(:disabled) { background: #1a8cd8; }
  button.toggle[aria-pressed="true"] { background: #fdf3d0; border-color: #c99700; }
  button.plain { border-color: transparent; padding: 4px 6px; color: #536471; }
  [hidden] { display: none !important; }
`;
