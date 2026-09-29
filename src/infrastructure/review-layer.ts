import type { ReviewActionResult, ReviewAnnotationPort, ReviewOverall } from '../domain/review-record';
import type { ReviewRuleView, ReviewSnapshot } from '../domain/review';
import { translate, type TranslationKey, type UiLocale } from '../ui/i18n';
import {
  DEFAULT_VIEW_FILTER,
  matchesFilter,
  summarizeView,
  type ReviewViewFilter,
  type ReviewViewItem,
  type ReviewViewSummary,
} from '../domain/review-view';
import { ReviewPanel } from './review-panel';

import { CURRENT_ATTRIBUTE, HOST_ATTRIBUTE, isReviewNode } from './review-dom';

export { HOST_ATTRIBUTE, isReviewNode };
export const REVIEW_ATTRIBUTE = 'data-anyfilter-review';
const RELATIVE_ATTRIBUTE = 'data-anyfilter-relative';
const VALUABLE_ATTRIBUTE = 'data-anyfilter-valuable';
const COLLAPSED_ATTRIBUTE = 'data-anyfilter-collapsed';
const LABEL_HOST = 'label';
const FILTERED_CLASS = 'anyfilter-review-filtered';
const PAUSED_ATTRIBUTE = 'data-anyfilter-paused';
const CELL_SELECTOR = '[data-testid="cellInnerDiv"]';

export const STATE_COLORS = {
  kept: '#1a7f45',
  flagged: '#b4472f',
  undecided: '#b7791f',
} as const;
const GOLD = '#c99700';

const STYLE_ID = 'anyfilter-review-style';

function percent(value: number): number {
  return Math.round(value * 100);
}

export type Translator = (key: TranslationKey, params?: Readonly<Record<string, string | number>>) => string;

/**
 * Draws the review decoration on X articles: an outline and a small status label
 * kept in a shadow root, so X's styles cannot reach it and ours cannot leak.
 *
 * Everything here is display only. The layer never hides a post through the
 * feed's `hide()`, never sends a message and never touches a setting. A person
 * can collapse a post for now; that is a display state in this page's memory and
 * writes no label. Every injected node carries {@link HOST_ATTRIBUTE}.
 */
export class ReviewLayer {
  private locale: UiLocale = 'en';
  private annotations: ReviewAnnotationPort | null = null;
  private readonly decorated = new Map<HTMLElement, ReviewSnapshot>();
  /** Sample ids the person collapsed for now. Memory only; never stored. */
  private readonly collapsed = new Set<string>();
  private readonly panel: ReviewPanel;
  private filter: ReviewViewFilter = DEFAULT_VIEW_FILTER;
  private paused = false;
  private listener: (() => void) | null = null;
  private notifyScheduled = false;
  /** What each article was last drawn from, so an unchanged post costs nothing. */
  private readonly renderKeys = new WeakMap<HTMLElement, string>();

  constructor() {
    this.installStyles();
    this.panel = new ReviewPanel(this);
  }

  setLocale(locale: UiLocale): void {
    if (locale === this.locale) return;
    this.locale = locale;
    this.refresh();
    this.panel.relocalize();
  }

  readonly t: Translator = (key, params) => translate(this.locale, key, params);

  setAnnotations(port: ReviewAnnotationPort | null): void {
    this.annotations = port;
  }

  annotationPort(): ReviewAnnotationPort | null {
    return this.annotations;
  }

  /** Re-draws every decorated post, e.g. after a label was stored or removed. */
  refresh(): void {
    for (const [article, snapshot] of this.decorated) {
      if (article.isConnected) this.render(article, snapshot);
    }
    this.panel.sync();
    // The toolbar's labelled total changes with the stored labels.
    this.notify();
  }

  entries(): ReadonlyMap<HTMLElement, ReviewSnapshot> {
    return this.decorated;
  }

  /** The toolbar listens here to keep its counts and rule list current. */
  onChange(listener: (() => void) | null): void {
    this.listener = listener;
  }

  private notify(): void {
    if (this.notifyScheduled || !this.listener) return;
    this.notifyScheduled = true;
    requestAnimationFrame(() => {
      this.notifyScheduled = false;
      this.listener?.();
    });
  }

  /** The filter in force. While paused nothing is filtered out. */
  private effectiveFilter(): ReviewViewFilter {
    return this.paused ? DEFAULT_VIEW_FILTER : this.filter;
  }

  getFilter(): ReviewViewFilter {
    return this.filter;
  }

  setFilter(filter: ReviewViewFilter): void {
    this.filter = filter;
    this.refresh();
    this.notify();
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Pause shows the plain feed again (no outlines, labels or filtering) without
   * leaving review mode. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      document.documentElement.setAttribute(PAUSED_ATTRIBUTE, '');
      this.panel.closeAll();
    } else {
      document.documentElement.removeAttribute(PAUSED_ATTRIBUTE);
    }
    this.refresh();
    this.notify();
  }

  /** Every decorated post that is still on the page, with its annotation. */
  items(): ReviewViewItem[] {
    this.forgetDisconnected();
    const items: ReviewViewItem[] = [];
    for (const snapshot of this.decorated.values()) {
      items.push({ snapshot, record: this.annotations?.recordFor(snapshot) });
    }
    return items;
  }

  /** Loaded and filtered-out counts describe the posts on the page. The labelled
   * count is everything stored: X drops posts far above and below the screen from
   * the page, and a count of only the posts still on it would fall as you scroll. */
  summary(): ReviewViewSummary {
    const summary = summarizeView(this.items(), this.effectiveFilter());
    return { ...summary, labeled: this.annotations?.labeledCount() ?? summary.labeled };
  }

  private hideTarget(article: HTMLElement): HTMLElement | null {
    const target = article.closest<HTMLElement>(CELL_SELECTOR)?.firstElementChild;
    return target instanceof HTMLElement ? target : null;
  }

  isCollapsed(snapshot: ReviewSnapshot): boolean {
    return this.collapsed.has(snapshot.sampleId);
  }

  setCollapsed(snapshot: ReviewSnapshot, collapsed: boolean): void {
    if (collapsed) this.collapsed.add(snapshot.sampleId);
    else this.collapsed.delete(snapshot.sampleId);
    for (const [article, decorated] of this.decorated) {
      if (decorated.sampleId === snapshot.sampleId && article.isConnected) this.render(article, decorated);
    }
    if (collapsed) this.panel.closeFor(snapshot.sampleId);
  }

  render(article: HTMLElement, snapshot: ReviewSnapshot): void {
    this.forgetDisconnected();
    const previous = this.decorated.get(article);
    if (previous && previous.sampleId !== snapshot.sampleId) this.panel.closeFor(previous.sampleId);
    this.decorated.set(article, snapshot);
    const record = this.annotations?.recordFor(snapshot);
    const collapsedNow = this.collapsed.has(snapshot.sampleId);
    const filteredOut = !matchesFilter({ snapshot, record }, this.effectiveFilter());
    const key = JSON.stringify([
      filteredOut, this.locale, snapshot.sampleId, snapshot.state, snapshot.direct, snapshot.putBack,
      snapshot.undecidedReason, snapshot.rules, record?.revision, record?.overall, record?.valuable, collapsedNow,
    ]);
    this.panel.snapshotChanged(article, snapshot);
    this.hideTarget(article)?.classList.toggle(FILTERED_CLASS, filteredOut);
    if (this.renderKeys.get(article) === key && article.querySelector(`:scope > [${HOST_ATTRIBUTE}="${LABEL_HOST}"]`)) {
      return;
    }
    this.renderKeys.set(article, key);
    this.notify();
    article.setAttribute(REVIEW_ATTRIBUTE, snapshot.state);
    if (record?.valuable) article.setAttribute(VALUABLE_ATTRIBUTE, '');
    else article.removeAttribute(VALUABLE_ATTRIBUTE);
    const collapsed = this.collapsed.has(snapshot.sampleId);
    if (collapsed) article.setAttribute(COLLAPSED_ATTRIBUTE, '');
    else article.removeAttribute(COLLAPSED_ATTRIBUTE);
    if (getComputedStyle(article).position === 'static') {
      article.setAttribute(RELATIVE_ATTRIBUTE, '');
    }
    const host = this.hostOf(article);
    const root = host.shadowRoot;
    if (!root) return;
    const label = root.querySelector<HTMLButtonElement>('.label');
    const state = root.querySelector<HTMLElement>('.state');
    const chips = root.querySelector<HTMLElement>('.chips');
    const detail = root.querySelector<HTMLElement>('.detail');
    const restore = root.querySelector<HTMLButtonElement>('.restore');
    const bar = root.querySelector<HTMLElement>('.bar');
    const quickKeep = root.querySelector<HTMLButtonElement>('.quick.keep');
    const quickHide = root.querySelector<HTMLButtonElement>('.quick.hide');
    if (!label || !state || !chips || !detail || !restore || !bar || !quickKeep || !quickHide) return;
    state.textContent = this.stateText(snapshot);
    state.style.background = STATE_COLORS[snapshot.state];
    const chipTexts: string[] = [];
    if (record?.valuable) chipTexts.push(this.t('review.label.valuable'));
    if (record?.overall) chipTexts.push(this.t('review.label.labeled'));
    chips.replaceChildren(
      ...chipTexts.map((text) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = text;
        return chip;
      }),
    );
    label.setAttribute(
      'aria-label',
      `${this.t('review.label.aria', { state: this.describe(snapshot) })}. ${this.t('review.label.open')}`,
    );
    bar.hidden = collapsed;
    restore.hidden = !collapsed;
    // One-click verdicts. The button that agrees with the model's own judgement
    // is drawn stronger, so the common "yes, that is right" is the obvious click.
    const agrees: ReviewOverall | null = snapshot.state === 'kept' ? 'keep' : snapshot.state === 'flagged' ? 'hide' : null;
    for (const [button, overall] of [[quickKeep, 'keep'], [quickHide, 'hide']] as const) {
      button.textContent = this.t(overall === 'keep' ? 'review.post.keep' : 'review.post.hide');
      button.setAttribute('aria-pressed', String(record?.overall === overall));
      button.dataset.agree = String(agrees === overall);
      button.title = this.t(overall === 'keep' ? 'review.quick.keepTip' : 'review.quick.hideTip');
    }
    restore.textContent = `${this.t('review.label.collapsed')} · ${this.t('review.post.restore')}`;
    detail.replaceChildren(
      ...this.detailLines(snapshot).map((line) => {
        const row = document.createElement('div');
        row.textContent = line;
        return row;
      }),
    );
  }

  clear(article: HTMLElement): void {
    const previous = this.decorated.get(article);
    if (previous) this.panel.closeFor(previous.sampleId);
    this.decorated.delete(article);
    this.renderKeys.delete(article);
    this.hideTarget(article)?.classList.remove(FILTERED_CLASS);
    this.notify();
    article.removeAttribute(REVIEW_ATTRIBUTE);
    article.removeAttribute(VALUABLE_ATTRIBUTE);
    article.removeAttribute(COLLAPSED_ATTRIBUTE);
    article.removeAttribute(RELATIVE_ATTRIBUTE);
    for (const host of article.querySelectorAll(`:scope > [${HOST_ATTRIBUTE}="${LABEL_HOST}"]`)) {
      host.remove();
    }
  }

  clearAll(): void {
    for (const article of [...this.decorated.keys()]) this.clear(article);
    this.decorated.clear();
    this.collapsed.clear();
    this.panel.closeAll();
    this.filter = DEFAULT_VIEW_FILTER;
    this.setPausedQuietly(false);
  }

  private setPausedQuietly(paused: boolean): void {
    this.paused = paused;
    document.documentElement.removeAttribute(PAUSED_ATTRIBUTE);
  }

  /** The label button of a decorated post, for the panel's focus handling. */
  labelOf(article: HTMLElement): HTMLButtonElement | null {
    return (
      article
        .querySelector<HTMLElement>(`:scope > [${HOST_ATTRIBUTE}="${LABEL_HOST}"]`)
        ?.shadowRoot?.querySelector<HTMLButtonElement>('.label') ?? null
    );
  }

  private forgetDisconnected(): void {
    for (const article of this.decorated.keys()) {
      if (!article.isConnected) this.decorated.delete(article);
    }
  }

  private hostOf(article: HTMLElement): HTMLElement {
    const existing = article.querySelector<HTMLElement>(
      `:scope > [${HOST_ATTRIBUTE}="${LABEL_HOST}"]`,
    );
    if (existing) return existing;
    const host = document.createElement('div');
    host.setAttribute(HOST_ATTRIBUTE, LABEL_HOST);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = LABEL_STYLES;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'label';
    label.setAttribute('aria-haspopup', 'dialog');
    label.setAttribute('aria-expanded', 'false');
    const state = document.createElement('span');
    state.className = 'state';
    const chips = document.createElement('span');
    chips.className = 'chips';
    label.append(state, chips);
    label.addEventListener('click', () => {
      const snapshot = this.decorated.get(article);
      if (snapshot) this.panel.toggle(article, snapshot);
    });
    const bar = document.createElement('div');
    bar.className = 'bar';
    const quick = (overall: 'keep' | 'hide'): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `quick ${overall}`;
      button.addEventListener('click', () => void this.quick(article, overall));
      return button;
    };
    bar.append(label, quick('keep'), quick('hide'));
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'restore';
    restore.hidden = true;
    restore.addEventListener('click', () => {
      const snapshot = this.decorated.get(article);
      if (snapshot) this.setCollapsed(snapshot, false);
    });
    const detail = document.createElement('div');
    detail.className = 'detail';
    wrap.append(bar, restore, detail);
    root.append(style, wrap);
    // A click on our own controls must never reach X's tweet handlers, which
    // would open the post or trigger a like.
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'keydown', 'keyup', 'keypress'] as const) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }
    article.append(host);
    return host;
  }

  /**
   * The one-click verdicts on a post. "Should keep" stores a keep verdict at once.
   * "Should hide" stores the rules the model itself hit; when it hit none, the
   * panel opens with hide chosen and one rule click finishes it. Pressing the
   * verdict that is already stored takes the label back. A failed save opens the
   * panel, which says why.
   */
  private async quick(article: HTMLElement, overall: 'keep' | 'hide'): Promise<void> {
    const snapshot = this.decorated.get(article);
    const port = this.annotations;
    if (!snapshot || !port) return;
    const stored = port.recordFor(snapshot);
    let result: ReviewActionResult;
    if (stored?.overall === overall) {
      result = await port.removeLabel(snapshot);
    } else if (overall === 'keep') {
      result = await port.saveDraft(snapshot, { overall, ruleIds: [], noRuleCovers: false, reason: '' });
    } else {
      const hits = snapshot.rules.filter((rule) => rule.hit).map((rule) => rule.ruleId);
      if (hits.length === 0) {
        this.panel.openWith(article, snapshot, { overall: 'hide' });
        return;
      }
      result = await port.saveDraft(snapshot, { overall, ruleIds: hits, noRuleCovers: false, reason: '' });
    }
    if (!result.ok) this.panel.openWith(article, snapshot, { error: result.error });
  }

  stateText(snapshot: ReviewSnapshot): string {
    if (snapshot.state === 'kept') {
      return this.t(snapshot.putBack ? 'review.state.putBack' : 'review.state.kept');
    }
    if (snapshot.state === 'flagged') {
      return this.t(snapshot.direct ? 'review.state.flagged' : 'review.state.flaggedLinked');
    }
    return this.t('review.state.undecided');
  }

  private describe(snapshot: ReviewSnapshot): string {
    const state = this.stateText(snapshot);
    if (snapshot.state !== 'undecided' || !snapshot.undecidedReason) return state;
    return `${state}, ${this.t(`review.undecided.${snapshot.undecidedReason}`)}`;
  }

  ruleText(rule: ReviewRuleView): string {
    if (rule.local) return this.t('review.rule.local', { label: rule.label });
    if (rule.score === null || rule.threshold === null) {
      return this.t('review.rule.unscored', { label: rule.label });
    }
    return this.t('review.rule.scored', {
      label: rule.label,
      score: percent(rule.score),
      threshold: percent(rule.threshold),
    });
  }

  private detailLines(snapshot: ReviewSnapshot): string[] {
    const lines: string[] = [];
    if (snapshot.state === 'undecided' && snapshot.undecidedReason) {
      lines.push(this.t(`review.undecided.${snapshot.undecidedReason}`));
    }
    const shown = snapshot.rules.filter((rule) => rule.hit || rule.score !== null);
    for (const rule of shown) lines.push(this.ruleText(rule));
    return lines;
  }

  private installStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute(HOST_ATTRIBUTE, 'style');
    style.textContent = `
      [${RELATIVE_ATTRIBUTE}] { position: relative !important; }
      .${FILTERED_CLASS} { display: none !important; }
      [${REVIEW_ATTRIBUTE}] { outline-width: 1px; outline-style: solid; outline-offset: -1px; }
      [${REVIEW_ATTRIBUTE}="kept"] { outline-color: ${STATE_COLORS.kept}55; }
      [${REVIEW_ATTRIBUTE}="flagged"] { outline-color: ${STATE_COLORS.flagged}66; }
      [${REVIEW_ATTRIBUTE}="undecided"] { outline-color: ${STATE_COLORS.undecided}66; }
      [${REVIEW_ATTRIBUTE}]:hover, [${REVIEW_ATTRIBUTE}]:focus-within, [${REVIEW_ATTRIBUTE}][${CURRENT_ATTRIBUTE}] { outline-width: 2px; outline-offset: -2px; }
      [${REVIEW_ATTRIBUTE}="kept"]:hover, [${REVIEW_ATTRIBUTE}="kept"]:focus-within, [${REVIEW_ATTRIBUTE}="kept"][${CURRENT_ATTRIBUTE}] { outline-color: ${STATE_COLORS.kept}; }
      [${REVIEW_ATTRIBUTE}="flagged"]:hover, [${REVIEW_ATTRIBUTE}="flagged"]:focus-within, [${REVIEW_ATTRIBUTE}="flagged"][${CURRENT_ATTRIBUTE}] { outline-color: ${STATE_COLORS.flagged}; }
      [${REVIEW_ATTRIBUTE}="undecided"]:hover, [${REVIEW_ATTRIBUTE}="undecided"]:focus-within, [${REVIEW_ATTRIBUTE}="undecided"][${CURRENT_ATTRIBUTE}] { outline-color: ${STATE_COLORS.undecided}; }
      [${REVIEW_ATTRIBUTE}][${VALUABLE_ATTRIBUTE}] { outline: 3px solid ${GOLD}; outline-offset: -3px; }
      [${PAUSED_ATTRIBUTE}] [${REVIEW_ATTRIBUTE}] { outline: none !important; }
      [${PAUSED_ATTRIBUTE}] [${HOST_ATTRIBUTE}="${LABEL_HOST}"], [${PAUSED_ATTRIBUTE}] [${HOST_ATTRIBUTE}="panel"] { display: none !important; }
      @media (prefers-reduced-motion: no-preference) {
        [${REVIEW_ATTRIBUTE}] { transition: outline-color 160ms ease; }
      }
      [${HOST_ATTRIBUTE}="${LABEL_HOST}"] { position: absolute; top: 4px; right: 56px; z-index: 3; }
      [${COLLAPSED_ATTRIBUTE}] > :not([${HOST_ATTRIBUTE}]) { display: none !important; }
      [${COLLAPSED_ATTRIBUTE}] > [${HOST_ATTRIBUTE}="${LABEL_HOST}"] { position: static !important; padding: 6px 12px; }
    `;
    (document.head ?? document.documentElement).append(style);
  }
}

const LABEL_STYLES = `
  :host { all: initial; }
  .wrap { position: relative; font: 600 12px/1.3 system-ui, sans-serif; opacity: 0.85; }
  @media (prefers-reduced-motion: no-preference) { .wrap { transition: opacity 160ms ease; } }
  :host(:hover) .wrap, :host(:focus-within) .wrap { opacity: 1; }
  .bar { display: inline-flex; align-items: center; gap: 4px; }
  .bar[hidden], .restore[hidden] { display: none; }
  .label { all: unset; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; padding: 3px 0; }
  .label:focus-visible, .restore:focus-visible, .quick:focus-visible { outline: 2px solid #1d9bf0; outline-offset: 2px; border-radius: 999px; }
  .state { display: inline-block; padding: 4px 11px; border-radius: 999px; color: #fff; white-space: nowrap; }
  .label:hover .state { filter: brightness(1.12); }
  .chips { display: inline-flex; gap: 4px; }
  .chip { display: inline-block; padding: 3px 7px; border-radius: 999px; background: #fff; color: #0f1419;
    border: 1px solid #cfd9de; white-space: nowrap; }
  .quick { all: unset; box-sizing: border-box; cursor: pointer; padding: 4px 11px; border-radius: 999px; white-space: nowrap;
    background: #fff; color: #0f1419; border: 1px solid #cfd9de; }
  .quick:hover { background: #eff3f4; }
  .quick[data-agree="true"] { font-weight: 700; }
  .quick.keep[data-agree="true"] { border-color: ${STATE_COLORS.kept}; color: ${STATE_COLORS.kept}; }
  .quick.hide[data-agree="true"] { border-color: ${STATE_COLORS.flagged}; color: ${STATE_COLORS.flagged}; }
  .quick[aria-pressed="true"] { color: #fff; border-color: transparent; }
  .quick.keep[aria-pressed="true"] { background: ${STATE_COLORS.kept}; }
  .quick.hide[aria-pressed="true"] { background: ${STATE_COLORS.flagged}; }
  .restore { all: unset; cursor: pointer; padding: 4px 11px; border-radius: 999px; background: #eff3f4; color: #0f1419;
    border: 1px solid #cfd9de; }
  .detail { display: none; position: absolute; top: 100%; right: 0; margin-top: 4px; min-width: 200px; max-width: 280px;
    padding: 8px 10px; border-radius: 8px; background: #fff; color: #0f1419; font-weight: 500;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18); border: 1px solid #cfd9de; }
  .detail:empty { display: none !important; }
  :host(:hover) .detail, :host(:focus-within) .detail { display: block; }
`;
