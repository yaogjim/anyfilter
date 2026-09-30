import type { ReviewRuleView, ReviewSnapshot } from '../domain/review';
import { translate, type TranslationKey, type UiLocale } from '../ui/i18n';
import { HOST_ATTRIBUTE } from './review-dom';

export const HN_REVIEW_ATTRIBUTE = 'data-anyfilter-review';
export const HN_REVIEW_LINE_CLASS = 'anyfilter-hn-review-line';

const COLORS = { kept: '#1a7f45', flagged: '#b4472f', undecided: '#b7791f' } as const;

function percent(value: number): number {
  return Math.round(value * 100);
}

/** The rows of a submission that carry the outline colour. */
export const HN_REVIEW_CSS = `
tr[${HN_REVIEW_ATTRIBUTE}="kept"] > td { background: rgba(26, 127, 69, 0.07) !important; }
tr[${HN_REVIEW_ATTRIBUTE}="flagged"] > td { background: rgba(180, 71, 47, 0.12) !important; }
tr[${HN_REVIEW_ATTRIBUTE}="undecided"] > td { background: rgba(183, 121, 31, 0.12) !important; }
tr.athing[${HN_REVIEW_ATTRIBUTE}="kept"] > td:first-child { box-shadow: inset 4px 0 0 ${COLORS.kept}; }
tr.athing[${HN_REVIEW_ATTRIBUTE}="flagged"] > td:first-child { box-shadow: inset 4px 0 0 ${COLORS.flagged}; }
tr.athing[${HN_REVIEW_ATTRIBUTE}="undecided"] > td:first-child { box-shadow: inset 4px 0 0 ${COLORS.undecided}; }
`;

/**
 * What review mode draws on a Hacker News list: the submission is tinted and
 * outlined by what AnyFilter would do with it, and one line under it says why
 * (each rule's score against its threshold). Display only: nothing here hides a
 * row, sends a message or stores anything. It has no labelling; that belongs to
 * the X timeline, which is the only place evaluation data is collected.
 */
export class HnReviewLayer {
  private locale: UiLocale = 'en';
  private readonly decorated = new Map<Element, ReviewSnapshot>();
  private readonly keys = new WeakMap<Element, string>();

  setLocale(locale: UiLocale): void {
    if (locale === this.locale) return;
    this.locale = locale;
    for (const [row, snapshot] of this.decorated) {
      if (row.isConnected) this.render(row, snapshot, subtextOf(row));
    }
  }

  readonly t = (key: TranslationKey, params?: Readonly<Record<string, string | number>>): string =>
    translate(this.locale, key, params);

  render(row: Element, snapshot: ReviewSnapshot, subtext: Element | null): void {
    this.decorated.set(row, snapshot);
    const key = `${this.locale}\u0000${JSON.stringify([snapshot.state, snapshot.undecidedReason, snapshot.direct, snapshot.putBack, snapshot.rules])}`;
    const existing = lineOf(row);
    if (this.keys.get(row) === key && existing !== null && existing.isConnected) return;
    this.keys.set(row, key);

    const line = existing ?? this.createLine();
    if (subtext !== null && line.previousElementSibling !== subtext) subtext.after(line);
    row.setAttribute(HN_REVIEW_ATTRIBUTE, snapshot.state);
    subtext?.setAttribute(HN_REVIEW_ATTRIBUTE, snapshot.state);
    line.setAttribute(HN_REVIEW_ATTRIBUTE, snapshot.state);
    this.fill(line, snapshot);
  }

  clear(row: Element): void {
    this.decorated.delete(row);
    this.keys.delete(row);
    row.removeAttribute(HN_REVIEW_ATTRIBUTE);
    subtextOf(row)?.removeAttribute(HN_REVIEW_ATTRIBUTE);
    lineOf(row)?.remove();
  }

  clearAll(): void {
    for (const row of [...this.decorated.keys()]) this.clear(row);
    for (const line of document.querySelectorAll(`.${HN_REVIEW_LINE_CLASS}`)) line.remove();
    for (const node of document.querySelectorAll(`[${HN_REVIEW_ATTRIBUTE}]`)) node.removeAttribute(HN_REVIEW_ATTRIBUTE);
  }

  counts(): { kept: number; flagged: number; undecided: number } {
    const counts = { kept: 0, flagged: 0, undecided: 0 };
    for (const [row, snapshot] of this.decorated) if (row.isConnected) counts[snapshot.state] += 1;
    return counts;
  }

  private createLine(): HTMLElement {
    const line = document.createElement('tr');
    line.className = HN_REVIEW_LINE_CLASS;
    line.setAttribute(HOST_ATTRIBUTE, 'hn-review');
    // Two columns of the title row's width first, so the text lines up under the
    // title like the score line does.
    const gutter = document.createElement('td');
    gutter.colSpan = 2;
    const cell = document.createElement('td');
    // A table cell cannot hold a shadow root itself, so a plain element does.
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' });
    cell.append(host);
    line.append(gutter, cell);
    return line;
  }

  private fill(line: Element, snapshot: ReviewSnapshot): void {
    const root = line.querySelector('div')?.shadowRoot;
    if (!root) return;
    const color = COLORS[snapshot.state];
    const style = document.createElement('style');
    style.textContent = `
      .box { font: 11px/1.5 Verdana, Geneva, sans-serif; color: #444; padding: 1px 0 3px; }
      .state { font-weight: 700; color: ${color}; margin-right: 6px; }
      .rule { margin-right: 8px; white-space: nowrap; }
      .rule.hit { color: ${COLORS.flagged}; font-weight: 700; }
    `;
    const box = document.createElement('div');
    box.className = 'box';
    box.setAttribute('role', 'note');
    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = this.describe(snapshot);
    box.append(state);
    if (snapshot.state === 'undecided' && snapshot.undecidedReason) {
      const why = document.createElement('span');
      why.className = 'rule';
      why.textContent = this.t(`review.undecided.${snapshot.undecidedReason}`);
      box.append(why);
    }
    for (const rule of snapshot.rules) {
      if (!rule.hit && rule.score === null) continue;
      const span = document.createElement('span');
      span.className = rule.hit ? 'rule hit' : 'rule';
      span.textContent = this.ruleText(rule);
      box.append(span);
    }
    root.replaceChildren(style, box);
  }

  private describe(snapshot: ReviewSnapshot): string {
    const base =
      snapshot.state === 'kept'
        ? this.t('review.state.kept')
        : snapshot.state === 'flagged'
          ? this.t('review.state.flagged')
          : this.t('review.state.undecided');
    return snapshot.putBack ? `${base} · ${this.t('review.state.putBack')}` : base;
  }

  private ruleText(rule: ReviewRuleView): string {
    if (rule.local) return this.t('review.rule.local', { label: rule.label });
    if (rule.score === null || rule.threshold === null) return this.t('review.rule.unscored', { label: rule.label });
    return this.t('review.rule.scored', {
      label: rule.label,
      score: percent(rule.score),
      threshold: percent(rule.threshold),
    });
  }
}

function subtextOf(row: Element): Element | null {
  const next = row.nextElementSibling;
  return next !== null && next.querySelector('td.subtext') !== null ? next : null;
}

function lineOf(row: Element): Element | null {
  const subtext = subtextOf(row);
  const next = subtext?.nextElementSibling ?? null;
  return next !== null && next.classList.contains(HN_REVIEW_LINE_CLASS) ? next : null;
}

/**
 * The small bar shown while review mode is on. It says so, offers the exit, and
 * shows how many of the loaded rows fall in each state. It floats over the page in
 * a shadow root.
 */
export class HnReviewBar {
  private host: HTMLElement | null = null;
  private filterOn = true;
  private readonly layer: HnReviewLayer;
  private readonly onExit: () => void;
  private timer: number | null = null;
  private drawn = '';

  constructor(layer: HnReviewLayer, onExit: () => void) {
    this.layer = layer;
    this.onExit = onExit;
  }

  mount(): void {
    if (this.host) return;
    const host = document.createElement('div');
    host.setAttribute(HOST_ATTRIBUTE, 'hn-review-bar');
    host.attachShadow({ mode: 'open' });
    document.body.append(host);
    this.host = host;
    this.render();
    this.timer = window.setInterval(() => this.render(), 1000);
  }

  unmount(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.host?.remove();
    this.host = null;
  }

  update(state: { filterOn: boolean }): void {
    this.filterOn = state.filterOn;
    this.render();
  }

  render(): void {
    const root = this.host?.shadowRoot;
    if (!root) return;
    const t = this.layer.t;
    // Redraw only when something changed, so a click on Exit is never swallowed by
    // the bar being rebuilt under the pointer.
    const drawn = JSON.stringify([this.filterOn, this.layer.counts(), t('review.toolbar.title')]);
    if (drawn === this.drawn) return;
    this.drawn = drawn;
    const style = document.createElement('style');
    style.textContent = `
      .bar { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; display: flex; gap: 10px;
        align-items: center; background: #0f1419; color: #fff; padding: 8px 12px; border-radius: 10px;
        font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
      .kept { color: #6fdc9b; } .flagged { color: #ff9b85; } .undecided { color: #f3c36b; }
      button { font: inherit; font-weight: 600; color: #0f1419; background: #fff; border: 0;
        border-radius: 6px; padding: 4px 10px; cursor: pointer; }
    `;
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', t('review.toolbar.aria'));
    const title = document.createElement('strong');
    title.textContent = t('review.toolbar.title');
    bar.append(title);
    if (!this.filterOn) {
      const off = document.createElement('span');
      off.textContent = t('review.toolbar.filterOff');
      bar.append(off);
    } else {
      const counts = this.layer.counts();
      for (const state of ['flagged', 'kept', 'undecided'] as const) {
        const span = document.createElement('span');
        span.className = state;
        span.textContent = `${t(`review.state.${state}` as TranslationKey)} ${counts[state]}`;
        bar.append(span);
      }
    }
    const exit = document.createElement('button');
    exit.type = 'button';
    exit.textContent = t('review.toolbar.exit');
    exit.title = t('review.toolbar.exitTip');
    exit.addEventListener('click', () => this.onExit());
    bar.append(exit);
    root.replaceChildren(style, bar);
  }
}
