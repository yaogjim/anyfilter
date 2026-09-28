import { useRef, useState } from 'react';
import { PRICE_PER_INPUT_TOKEN } from '../../domain/panel-state';
import type { PreviewResult, PreviewRuleResult, Rule } from '../../domain/rule';

const INPUT_CLASS = 'w-full rounded-lg border border-[#cfd9de] bg-white px-2 py-1.5 text-[13px]';
const LABEL_CLASS = 'mb-1 block text-[11px] font-bold uppercase tracking-wide text-ink-2';

const STATUS_TONE: Record<PreviewRuleResult['status'], string> = {
  match: 'bg-hide text-white',
  'no-match': 'bg-surface text-ink-2',
  unavailable: 'bg-surface text-ink-2',
  'not-applicable': 'bg-surface text-ink-2',
};

const STATUS_TEXT: Record<PreviewRuleResult['status'], string> = {
  match: 'would hide',
  'no-match': 'below threshold',
  unavailable: 'no score',
  'not-applicable': 'not applicable',
};

function errorText(error: string, detail: string): string {
  switch (error) {
    case 'no-key':
      return 'Add an API key in Settings before testing.';
    case 'auth':
      return 'The provider rejected your API key (401/403). Check it in Settings.';
    case 'rate-limited':
      return `The provider is rate-limiting this key${detail ? `: ${detail}` : '.'}`;
    case 'network':
      return `Could not reach the provider: ${detail}`;
    case 'invalid':
      return detail;
    case 'bad-response':
      return `Unexpected provider response: ${detail}`;
    default:
      return detail === '' ? error : `${error}: ${detail}`;
  }
}

function costText(tokens: number): string {
  if (tokens === 0) return '$0';
  const cost = tokens * PRICE_PER_INPUT_TOKEN;
  return cost < 0.001 ? '<$0.001' : `$${cost.toFixed(3)}`;
}

interface Fields {
  text: string;
  name: string;
  handle: string;
  quotedText: string;
  parentText: string;
}

/** Everything that can change the answer, so a result is only fresh while the
 * exact rules, threshold, and tested text still match what was sent. */
function fingerprintOf(fields: Fields, rules: readonly Rule[], threshold: number): string {
  return JSON.stringify([
    rules,
    threshold,
    fields.text,
    fields.name,
    fields.handle,
    fields.quotedText,
    fields.parentText,
  ]);
}

export function RulePreview({
  rules,
  threshold,
  onPreview,
}: {
  rules: readonly Rule[];
  threshold: number;
  onPreview: (input: {
    text: string;
    name?: string;
    handle?: string;
    quotedText?: string;
    parentText?: string;
    rules: Rule[];
    threshold: number;
  }) => Promise<PreviewResult>;
}) {
  const [fields, setFields] = useState<Fields>({
    text: '',
    name: '',
    handle: '',
    quotedText: '',
    parentText: '',
  });
  const [showContext, setShowContext] = useState(false);
  const [running, setRunning] = useState(false);
  const [shown, setShown] = useState<{ result: PreviewResult; fingerprint: string } | null>(null);
  const requestId = useRef(0);
  const currentFingerprint = fingerprintOf(fields, rules, threshold);
  // A result counts as stale once any input, threshold, or rule has changed
  // since it was produced — including edits made while a request was in flight.
  const stale = shown !== null && shown.fingerprint !== currentFingerprint;
  const update = (patch: Partial<Fields>): void => setFields((current) => ({ ...current, ...patch }));

  const run = (): void => {
    const text = fields.text.trim();
    if (text === '') return;
    const id = requestId.current + 1;
    requestId.current = id;
    const sentFingerprint = currentFingerprint;
    const trim = (value: string): string => value.trim();
    setRunning(true);
    void onPreview({
      text,
      rules: [...rules],
      threshold,
      ...(trim(fields.name) === '' ? {} : { name: trim(fields.name) }),
      ...(trim(fields.handle) === '' ? {} : { handle: trim(fields.handle).replace(/^@/, '') }),
      ...(trim(fields.quotedText) === '' ? {} : { quotedText: trim(fields.quotedText) }),
      ...(trim(fields.parentText) === '' ? {} : { parentText: trim(fields.parentText) }),
    }).then(
      (result) => {
        // A later test supersedes this one, so a slow response is dropped rather
        // than shown over a newer one.
        if (requestId.current !== id) return;
        setRunning(false);
        setShown({ result, fingerprint: sentFingerprint });
      },
      (error: unknown) => {
        if (requestId.current !== id) return;
        setRunning(false);
        setShown({
          result: {
            ok: false,
            error: 'network',
            detail: error instanceof Error ? error.message : String(error),
          },
          fingerprint: sentFingerprint,
        });
      },
    );
  };

  return (
    <div className="space-y-2.5">
      <label className="block">
        <span className={LABEL_CLASS}>Text to test</span>
        <textarea
          className={`${INPUT_CLASS} resize-y leading-snug`}
          rows={3}
          value={fields.text}
          placeholder="Paste one post or reply to see how the draft rules would judge it…"
          onChange={(event) => update({ text: event.target.value })}
        />
      </label>
      <button
        type="button"
        className="text-[11px] font-bold text-ink-2 underline"
        aria-expanded={showContext}
        onClick={() => setShowContext((current) => !current)}
      >
        {showContext ? 'Hide context' : 'Add context (author, quote, parent)'}
      </button>
      {showContext && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={LABEL_CLASS}>Author name</span>
            <input
              type="text"
              className={INPUT_CLASS}
              value={fields.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </label>
          <label className="block">
            <span className={LABEL_CLASS}>Handle</span>
            <input
              type="text"
              className={INPUT_CLASS}
              value={fields.handle}
              placeholder="@example"
              onChange={(event) => update({ handle: event.target.value })}
            />
          </label>
          <label className="col-span-2 block">
            <span className={LABEL_CLASS}>Quoted post</span>
            <textarea
              className={`${INPUT_CLASS} resize-y leading-snug`}
              rows={2}
              value={fields.quotedText}
              onChange={(event) => update({ quotedText: event.target.value })}
            />
          </label>
          <label className="col-span-2 block">
            <span className={LABEL_CLASS}>Parent post (for replies)</span>
            <textarea
              className={`${INPUT_CLASS} resize-y leading-snug`}
              rows={2}
              value={fields.parentText}
              onChange={(event) => update({ parentText: event.target.value })}
            />
          </label>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-lg border border-[#cfd9de] bg-white px-3 py-1.5 font-bold disabled:opacity-50"
          disabled={running || fields.text.trim() === ''}
          onClick={run}
        >
          {running ? 'Testing…' : 'Test text'}
        </button>
        <span className="text-[11px] text-ink-2">
          Sends this text to your provider and may cost tokens. Nothing is saved.
        </span>
      </div>

      {shown === null ? null : shown.result.ok ? (
        <div className="rounded-lg border border-line">
          {stale && (
            <p className="m-0 border-b border-line bg-surface px-2.5 py-1.5 text-[11px] text-ink-2">
              The text, context, threshold, or rules changed after this test. Test again to refresh
              it.
            </p>
          )}
          <p className="m-0 border-b border-line px-2.5 py-1.5 text-[11px] text-ink-2">
            Each score is the model's probability that the post matches that rule; “would hide”
            means it reached the threshold.
          </p>
          <ul className="m-0 list-none divide-y divide-line p-0">
            {shown.result.results.map((item) => (
              <li key={item.id} className="flex items-center gap-2 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate font-bold">{item.label}</span>
                {item.score !== undefined && (
                  <span
                    className="flex-none text-[11px] tabular-nums text-ink-2"
                    title="Model probability vs threshold"
                  >
                    {Math.round(item.score * 100)}% vs {Math.round(item.threshold * 100)}%
                  </span>
                )}
                <span
                  className={`flex-none rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_TONE[item.status]}`}
                >
                  {STATUS_TEXT[item.status]}
                </span>
              </li>
            ))}
          </ul>
          <p className="m-0 border-t border-line px-2.5 py-1.5 text-[11px] text-ink-2">
            {shown.result.tokens} input tokens · {costText(shown.result.tokens)}
            {shown.result.model ? ` · ${shown.result.model}` : ''}
          </p>
        </div>
      ) : (
        <p className="m-0 rounded-lg bg-surface px-2.5 py-2 text-[12px] text-hide">
          {errorText(shown.result.error, shown.result.detail)}
        </p>
      )}
    </div>
  );
}