import {
  DEFAULT_VIEW_FILTER,
  isDefaultFilter,
  REVIEW_SCOPES,
  rulesOf,
  sliderApplies,
  type ReviewScope,
  type ReviewViewFilter,
} from '../domain/review-view';
import type { TranslationKey } from '../ui/i18n';
import { HOST_ATTRIBUTE } from './review-dom';
import type { ReviewLayer } from './review-layer';

export interface ReviewToolbarHandlers {
  onExit(): void;
}

export interface ReviewToolbarState {
  filterOn: boolean;
}

const TOOLBAR_HOST = 'toolbar';

const SCOPE_KEY: Record<ReviewScope, TranslationKey> = {
  all: 'review.scope.all',
  flagged: 'review.scope.flagged',
  kept: 'review.scope.kept',
  undecided: 'review.scope.undecided',
  valuable: 'review.scope.valuable',
  labeled: 'review.scope.labeled',
};

interface Refs {
  counts: HTMLElement;
  scope: HTMLSelectElement;
  rule: HTMLSelectElement;
  slider: HTMLInputElement;
  sliderLabel: HTMLElement;
  sliderField: HTMLElement;
  showAll: HTMLButtonElement;
  pause: HTMLButtonElement;
  body: HTMLElement;
  fold: HTMLButtonElement;
  paused: HTMLElement;
  head: HTMLElement;
}

/**
 * The bar shown while review mode is on: which decorated posts to show, how many
 * are loaded, filtered out and labelled, a pause and an exit. It lives in a
 * shadow root and floats over the page, so it never disturbs X's layout. The head
 * row is a drag handle (arrow keys work too); the filters open on demand.
 *
 * Everything it does is display only. The filter and the slider live in page
 * memory: they change which decorated posts stay on screen, never what was
 * judged, never a setting, and they never ask the provider anything.
 */
export class ReviewToolbar {
  private host: HTMLElement | null = null;
  private state: ReviewToolbarState = { filterOn: true };
  private refs: Refs | null = null;
  private folded = true;
  /** Where the person dragged the bar to; `null` keeps the default bottom centre. */
  private pos: { x: number; y: number } | null = null;
  private drag: { pointerId: number; dx: number; dy: number } | null = null;
  private readonly onResize = (): void => this.applyPosition();
  private ruleKey = '';
  private readonly layer: ReviewLayer;
  private readonly handlers: ReviewToolbarHandlers;

  constructor(layer: ReviewLayer, handlers: ReviewToolbarHandlers) {
    this.layer = layer;
    this.handlers = handlers;
  }

  mount(): void {
    if (this.host) return;
    const host = document.createElement('div');
    host.setAttribute(HOST_ATTRIBUTE, TOOLBAR_HOST);
    host.attachShadow({ mode: 'open' });
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'keydown', 'keyup', 'keypress'] as const) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }
    document.body.append(host);
    this.host = host;
    this.layer.onChange(() => this.sync());
    window.addEventListener('resize', this.onResize);
    this.render();
  }

  /** Removes the bar and puts the page back: no filter, not paused. */
  unmount(): void {
    this.layer.onChange(null);
    this.layer.setPaused(false);
    this.layer.setFilter(DEFAULT_VIEW_FILTER);
    window.removeEventListener('resize', this.onResize);
    this.drag = null;
    this.host?.remove();
    this.host = null;
    this.refs = null;
  }

  update(state: ReviewToolbarState): void {
    this.state = state;
    this.render();
  }

  private setFilter(patch: Partial<ReviewViewFilter>): void {
    this.layer.setFilter({ ...this.layer.getFilter(), ...patch });
    this.sync();
  }

  /** Rebuilds the bar (first mount, language or filter-on change). */
  render(): void {
    const root = this.host?.shadowRoot;
    if (!root) return;
    const t = this.layer.t;
    const style = document.createElement('style');
    style.textContent = TOOLBAR_STYLES;
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', t('review.toolbar.aria'));

    const top = document.createElement('div');
    top.className = 'row head';
    top.tabIndex = 0;
    top.setAttribute('role', 'group');
    top.setAttribute('aria-label', t('review.toolbar.drag'));
    top.title = t('review.toolbar.drag');
    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⠿';
    const title = document.createElement('strong');
    title.textContent = t('review.toolbar.title');
    const counts = document.createElement('span');
    counts.className = 'counts';
    counts.setAttribute('role', 'status');
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.addEventListener('click', () => {
      this.folded = !this.folded;
      this.sync();
    });
    const pause = document.createElement('button');
    pause.type = 'button';
    pause.addEventListener('click', () => {
      this.layer.setPaused(!this.layer.isPaused());
      this.sync();
    });
    const exit = document.createElement('button');
    exit.type = 'button';
    exit.className = 'exit';
    exit.textContent = t('review.toolbar.exit');
    exit.title = t('review.toolbar.exitTip');
    exit.addEventListener('click', () => this.handlers.onExit());
    top.append(grip, title, counts, pause, fold, exit);
    this.bindDrag(top);

    const paused = document.createElement('div');
    paused.className = 'note';
    paused.setAttribute('role', 'status');

    const body = document.createElement('div');
    body.className = 'body';
    if (!this.state.filterOn) {
      const note = document.createElement('span');
      note.className = 'note';
      note.setAttribute('role', 'status');
      note.textContent = t('review.toolbar.filterOff');
      body.append(note);
    }

    const scope = document.createElement('select');
    for (const value of REVIEW_SCOPES) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = t(SCOPE_KEY[value]);
      scope.append(option);
    }
    scope.addEventListener('change', () => this.setFilter({ scope: scope.value as ReviewScope }));
    const rule = document.createElement('select');
    rule.addEventListener('change', () => {
      // A new rule starts from "any score", so the slider never carries over a
      // value that was chosen for another rule.
      this.setFilter({ ruleId: rule.value === '' ? null : rule.value, minScore: 0 });
    });
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '5';
    slider.value = '0';
    slider.addEventListener('input', () => this.setFilter({ minScore: Number(slider.value) / 100 }));
    const sliderLabel = document.createElement('span');
    sliderLabel.className = 'slider-label';
    const showAll = document.createElement('button');
    showAll.type = 'button';
    showAll.textContent = t('review.toolbar.showAll');
    showAll.addEventListener('click', () => {
      this.layer.setFilter(DEFAULT_VIEW_FILTER);
      this.sync();
    });

    const field = (labelKey: TranslationKey, control: HTMLElement): HTMLElement => {
      const wrap = document.createElement('label');
      wrap.className = 'field';
      const text = document.createElement('span');
      text.textContent = t(labelKey);
      wrap.append(text, control);
      return wrap;
    };
    const sliderField = document.createElement('label');
    sliderField.className = 'field slider';
    sliderField.append(sliderLabel, slider);
    const pickers = document.createElement('div');
    pickers.className = 'row';
    pickers.append(field('review.toolbar.scope', scope), field('review.toolbar.rule', rule));
    const scoring = document.createElement('div');
    scoring.className = 'row';
    scoring.append(sliderField, showAll);
    body.append(pickers, scoring);

    bar.append(top, paused, body);
    root.replaceChildren(style, bar);
    this.refs = { counts, scope, rule, slider, sliderLabel, sliderField, showAll, pause, body, fold, paused, head: top };
    this.ruleKey = '';
    this.sync();
  }

  /** Brings counts, the rule list and every control in line with the page. */
  sync(): void {
    const refs = this.refs;
    if (!refs) return;
    const t = this.layer.t;
    const filter = this.layer.getFilter();
    const items = this.layer.items();
    const summary = this.layer.summary();

    refs.counts.textContent = t('review.toolbar.counts', {
      loaded: summary.loaded,
      filtered: summary.filteredOut,
      labeled: summary.labeled,
    });

    const rules = rulesOf(items);
    const key = JSON.stringify(rules.map((rule) => [rule.ruleId, rule.label]));
    if (key !== this.ruleKey) {
      this.ruleKey = key;
      const options = [{ value: '', text: t('review.toolbar.anyRule') }, ...rules.map((rule) => ({ value: rule.ruleId, text: rule.label }))];
      refs.rule.replaceChildren(
        ...options.map(({ value, text }) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = text;
          return option;
        }),
      );
    }
    // A chosen rule whose posts scrolled away stays chosen; keep it selectable.
    if (filter.ruleId !== null && !Array.from(refs.rule.options).some((option) => option.value === filter.ruleId)) {
      const option = document.createElement('option');
      option.value = filter.ruleId;
      option.textContent = filter.ruleId;
      refs.rule.append(option);
    }
    refs.rule.value = filter.ruleId ?? '';
    refs.scope.value = filter.scope;

    const usable = sliderApplies(items, filter.ruleId);
    refs.slider.disabled = !usable;
    refs.slider.value = String(Math.round((usable ? filter.minScore : 0) * 100));
    refs.sliderLabel.textContent = t('review.toolbar.minScore', { value: Math.round(filter.minScore * 100) });
    // Why the slider is off lives in the tooltip instead of taking a line of its own.
    refs.sliderField.title = usable ? '' : t('review.toolbar.minScoreHint');
    refs.showAll.disabled = isDefaultFilter(filter);

    const paused = this.layer.isPaused();
    refs.pause.textContent = t(paused ? 'review.toolbar.resume' : 'review.toolbar.pause');
    refs.pause.setAttribute('aria-pressed', String(paused));
    refs.paused.textContent = paused ? t('review.toolbar.paused') : '';
    refs.paused.hidden = !paused;
    refs.fold.textContent = t(this.folded ? 'review.toolbar.expand' : 'review.toolbar.collapse');
    refs.fold.setAttribute('aria-expanded', String(!this.folded));
    refs.body.hidden = this.folded;
    this.applyPosition();
  }

  // ------------------------------------------------------------------ moving

  /** Puts the bar where the person left it, kept fully inside the window. */
  private applyPosition(): void {
    const host = this.host;
    if (!host) return;
    if (this.pos === null) {
      for (const property of ['left', 'top', 'bottom', 'transform']) host.style.removeProperty(property);
      return;
    }
    const rect = host.getBoundingClientRect();
    const maxX = Math.max(0, document.documentElement.clientWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);
    this.pos = { x: Math.min(Math.max(this.pos.x, 0), maxX), y: Math.min(Math.max(this.pos.y, 0), maxY) };
    host.style.left = `${Math.round(this.pos.x)}px`;
    host.style.top = `${Math.round(this.pos.y)}px`;
    host.style.bottom = 'auto';
    host.style.transform = 'none';
  }

  private moveTo(x: number, y: number): void {
    this.pos = { x, y };
    this.applyPosition();
  }

  private bindDrag(head: HTMLElement): void {
    const interactive = (event: Event): boolean =>
      event.target instanceof Element && event.target.closest('button, select, input, a') !== null;
    head.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || interactive(event) || !this.host) return;
      const rect = this.host.getBoundingClientRect();
      this.drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      head.setPointerCapture(event.pointerId);
      head.classList.add('dragging');
      this.moveTo(rect.left, rect.top);
      event.preventDefault();
    });
    head.addEventListener('pointermove', (event) => {
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      this.moveTo(event.clientX - drag.dx, event.clientY - drag.dy);
    });
    const end = (event: PointerEvent): void => {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      this.drag = null;
      head.classList.remove('dragging');
      if (head.hasPointerCapture(event.pointerId)) head.releasePointerCapture(event.pointerId);
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
    // A double click on the handle puts the bar back at the bottom centre.
    head.addEventListener('dblclick', (event) => {
      if (interactive(event)) return;
      this.pos = null;
      this.applyPosition();
    });
    head.addEventListener('keydown', (event) => {
      if (event.target !== head || !this.host) return;
      if (event.key === 'Home') {
        this.pos = null;
        this.applyPosition();
        event.preventDefault();
        return;
      }
      const step = event.shiftKey ? 64 : 16;
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const move = delta[event.key];
      if (!move) return;
      const rect = this.host.getBoundingClientRect();
      const from = this.pos ?? { x: rect.left, y: rect.top };
      this.moveTo(from.x + move[0], from.y + move[1]);
      event.preventDefault();
    });
  }
}

const TOOLBAR_STYLES = `
  :host { all: initial; position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483000;
    max-width: calc(100vw - 24px); }
  .bar { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px 6px 10px; border-radius: 14px;
    background: #0f1419; color: #fff; font: 500 12px/1.3 system-ui, sans-serif; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35); }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .head { flex-wrap: nowrap; cursor: grab; user-select: none; touch-action: none; }
  .head.dragging { cursor: grabbing; }
  .head:focus-visible { outline: 2px solid #fff; outline-offset: 2px; border-radius: 8px; }
  .grip { color: #8b98a5; font-size: 14px; line-height: 1; }
  .counts { flex: 1; min-width: 0; color: #cfd9de; white-space: nowrap; }
  .note { color: #f5d38a; }
  .body { display: flex; flex-direction: column; gap: 6px; padding: 2px 2px 2px 0; border-top: 1px solid #273340; padding-top: 6px; }
  .field { display: inline-flex; align-items: center; gap: 4px; color: #cfd9de; }
  .slider { flex: 1; min-width: 0; }
  .slider-label { white-space: nowrap; }
  select { font: inherit; background: #273340; color: #fff; border: 1px solid #536471; border-radius: 6px; padding: 2px 4px; }
  input[type="range"] { flex: 1; width: 100px; min-width: 60px; accent-color: #1d9bf0; }
  button { font: inherit; cursor: pointer; color: #fff; background: transparent; border: 1px solid #536471;
    border-radius: 999px; padding: 3px 10px; white-space: nowrap; }
  button:hover:not(:disabled) { background: #273340; }
  button:disabled, input:disabled { opacity: 0.5; cursor: default; }
  button[aria-pressed="true"] { background: #f5d38a; color: #0f1419; border-color: #f5d38a; }
  button[aria-expanded]::after { content: " ▾"; }
  button[aria-expanded="true"]::after { content: " ▴"; }
  button[aria-expanded="true"] { background: #273340; }
  button.exit { border-color: #f4212e; color: #ffb3b8; }
  button.exit:hover:not(:disabled) { background: #67070f; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  [hidden] { display: none !important; }
`;
