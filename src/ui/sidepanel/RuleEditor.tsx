import { useState } from 'react';
import {
  MAX_EXAMPLE_LENGTH,
  MAX_EXAMPLES_PER_SIDE,
  MAX_EXCLUDE_LENGTH,
  MAX_INCLUDE_LENGTH,
  type Rule,
} from '../../domain/rule';
import { compileRuleQuestion } from '../../domain/rule-compiler';
import { useLanguage } from '../language';

const INPUT_CLASS = 'w-full rounded-lg border border-[#cfd9de] bg-white px-2 py-1.5 text-[13px]';
const TEXTAREA_CLASS = `${INPUT_CLASS} resize-y leading-snug`;
const SMALL_BUTTON_CLASS =
  'rounded-lg border border-[#cfd9de] bg-white px-2.5 py-1 text-xs font-bold text-ink';
const FIELD_LABEL_CLASS = 'mb-1 block text-[11px] font-bold uppercase tracking-wide text-ink-2';

export function ExamplesEditor({
  title,
  items,
  onChange,
}: {
  title: string;
  items: readonly string[];
  onChange: (items: string[]) => void;
}) {
  const { t } = useLanguage();
  return (
    <div>
      <span className={FIELD_LABEL_CLASS}>{title}</span>
      <div className="space-y-1">
        {items.map((item, index) => (
          <div key={index} className="flex items-start gap-1.5">
            <input
              type="text"
              className={INPUT_CLASS}
              value={item}
              maxLength={MAX_EXAMPLE_LENGTH}
              placeholder={t('settings.examplePlaceholder')}
              aria-label={t('settings.exampleAria', { title, index: String(index + 1) })}
              onChange={(event) =>
                onChange(items.map((current, i) => (i === index ? event.target.value : current)))
              }
            />
            <button
              type="button"
              className="flex-none px-1.5 py-1.5 text-ink-2 hover:text-ink"
              aria-label={t('settings.removeExampleAria', { title, index: String(index + 1) })}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          </div>
        ))}
        {items.length < MAX_EXAMPLES_PER_SIDE && (
          <button
            type="button"
            className={SMALL_BUTTON_CLASS}
            onClick={() => onChange([...items, ''])}
          >
            {t('settings.addExample')}
          </button>
        )}
      </div>
    </div>
  );
}

export function ThresholdField({
  rule,
  onChange,
}: {
  rule: Rule;
  onChange: (patch: Partial<Rule>) => void;
}) {
  const { t } = useLanguage();
  const custom = rule.threshold !== undefined;
  const percent = Math.round((rule.threshold ?? 0.7) * 100);
  return (
    <div>
      <span className={FIELD_LABEL_CLASS}>{t('settings.threshold')}</span>
      <label className="flex cursor-pointer items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          className="anyfilter-check"
          checked={custom}
          onChange={(event) => onChange({ threshold: event.target.checked ? 0.7 : undefined })}
        />
        {t('settings.useDifferentThreshold')}
      </label>
      {custom ? (
        <label className="mt-1 block">
          <span className="text-ink-2">
            {t('settings.hideWhenProbabilityAtLeast')}{' '}
            <b className="text-ink tabular-nums">{percent}%</b>
          </span>
          <input
            type="range"
            className="anyfilter-range mt-1 w-full"
            min={50}
            max={95}
            step={5}
            value={percent}
            onChange={(event) => onChange({ threshold: Number(event.target.value) / 100 })}
          />
        </label>
      ) : (
        <p className="mt-1 text-[11px] text-ink-2">
          {t('settings.usesOverallThreshold')}
        </p>
      )}
    </div>
  );
}

/** The definition tab of a semantic rule: when it hides, what it spares, where it
 * applies and its own threshold, plus the exact instruction that is sent. */
export function DefinitionPanel({
  rule,
  onPatch,
}: {
  rule: Rule;
  onPatch: (patch: Partial<Rule>) => void;
}) {
  const { t } = useLanguage();
  const [showInstruction, setShowInstruction] = useState(false);
  const instruction = compileRuleQuestion(rule);
  if (rule.kind === 'local') {
    return (
      <p className="m-0 rounded-lg bg-surface px-2.5 py-2 text-[12px] text-ink-2">
        {t('settings.localCheckNote')}
      </p>
    );
  }
  return (
    <div className="space-y-2.5">
      <p className="m-0 rounded-lg bg-surface px-2.5 py-2 text-[12px] text-ink-2">
        {t('settings.originalRuleTextNote')}
      </p>
      <label className="block">
        <span className={FIELD_LABEL_CLASS}>{t('settings.hideWhen')}</span>
        <textarea
          className={TEXTAREA_CLASS}
          rows={3}
          maxLength={MAX_INCLUDE_LENGTH}
          value={rule.include}
          placeholder={t('settings.includePlaceholder')}
          onChange={(event) => onPatch({ include: event.target.value })}
        />
      </label>
      <label className="block">
        <span className={FIELD_LABEL_CLASS}>{t('settings.exceptWhen')}</span>
        <textarea
          className={TEXTAREA_CLASS}
          rows={2}
          maxLength={MAX_EXCLUDE_LENGTH}
          value={rule.exclude}
          placeholder={t('settings.excludePlaceholder')}
          onChange={(event) => onPatch({ exclude: event.target.value })}
        />
      </label>
      <fieldset>
        <legend className={FIELD_LABEL_CLASS}>{t('settings.appliesTo')}</legend>
        <div className="flex flex-wrap gap-3 text-[13px]">
          {(
            [
              { value: 'all', label: t('settings.allPosts') },
              { value: 'replies', label: t('settings.repliesOnlyNeedsParent') },
            ] as const
          ).map((option) => (
            <label key={option.value} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name={`anyfilter-scope-${rule.id}`}
                checked={rule.scope === option.value}
                onChange={() => onPatch({ scope: option.value })}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      <ThresholdField rule={rule} onChange={onPatch} />
      {instruction !== null && (
        <div>
          <button
            type="button"
            className="text-[11px] font-bold text-ink-2 underline"
            onClick={() => setShowInstruction((current) => !current)}
          >
            {showInstruction ? t('settings.hideInstruction') : t('settings.showInstruction')}
          </button>
          {showInstruction && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-2 text-[11px] text-ink-2">
              {instruction}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** The examples tab: what should be hidden and what should be kept, side by side
 * when there is room. */
export function ExamplesPanel({
  rule,
  onPatch,
}: {
  rule: Rule;
  onPatch: (patch: Partial<Rule>) => void;
}) {
  const { t } = useLanguage();
  if (rule.kind === 'local') {
    return <p className="m-0 rounded-lg bg-surface px-2.5 py-2 text-[12px] text-ink-2">{t('settings.noExamplesForLocal')}</p>;
  }
  return (
    <div className="space-y-2.5">
      <p className="m-0 text-[12px] text-ink-2">{t('settings.examplesIntro')}</p>
      <div className="grid gap-3 @[30rem]:grid-cols-2">
        <ExamplesEditor
          title={t('settings.shouldHide')}
          items={rule.examplesYes}
          onChange={(examplesYes) => onPatch({ examplesYes })}
        />
        <ExamplesEditor
          title={t('settings.shouldNotHide')}
          items={rule.examplesNo}
          onChange={(examplesNo) => onPatch({ examplesNo })}
        />
      </div>
    </div>
  );
}
