import { useState } from 'react';
import {
  MAX_EXAMPLE_LENGTH,
  MAX_EXAMPLES_PER_SIDE,
  MAX_EXCLUDE_LENGTH,
  MAX_INCLUDE_LENGTH,
  MAX_LABEL_LENGTH,
  type Rule,
} from '../../domain/rule';
import { compileRuleQuestion } from '../../domain/rule-compiler';
import { useLanguage } from '../language';

const INPUT_CLASS = 'w-full rounded-lg border border-[#cfd9de] bg-white px-2 py-1.5 text-[13px]';
const TEXTAREA_CLASS = `${INPUT_CLASS} resize-y leading-snug`;
const SMALL_BUTTON_CLASS =
  'rounded-lg border border-[#cfd9de] bg-white px-2.5 py-1 text-xs font-bold text-ink';
const FIELD_LABEL_CLASS = 'mb-1 block text-[11px] font-bold uppercase tracking-wide text-ink-2';

function ExamplesEditor({
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

function ThresholdField({
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

export function RuleEditor({
  rule,
  onPatch,
  onDelete,
}: {
  rule: Rule;
  onPatch: (patch: Partial<Rule>) => void;
  onDelete: (() => void) | null;
}) {
  const { t } = useLanguage();
  const [showInstruction, setShowInstruction] = useState(false);
  const instruction = compileRuleQuestion(rule);
  return (
    <div className="space-y-2.5 px-1 pb-3 pt-1">
      {rule.kind === 'local' ? (
        <p className="m-0 rounded-lg bg-surface px-2.5 py-2 text-[12px] text-ink-2">
          {t('settings.localCheckNote')}
        </p>
      ) : (
        <>
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
                {showInstruction
                  ? t('settings.hideInstruction')
                  : t('settings.showInstruction')}
              </button>
              {showInstruction && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-2 text-[11px] text-ink-2">
                  {instruction}
                </pre>
              )}
            </div>
          )}
        </>
      )}
      {onDelete && (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={`${SMALL_BUTTON_CLASS} text-hide`} onClick={onDelete}>
            {t('settings.deleteRule')}
          </button>
        </div>
      )}
    </div>
  );
}

export function RuleRow({
  rule,
  open,
  onToggleOpen,
  onPatch,
  onDelete,
}: {
  rule: Rule;
  open: boolean;
  onToggleOpen: () => void;
  onPatch: (patch: Partial<Rule>) => void;
  onDelete: (() => void) | null;
}) {
  const { t } = useLanguage();
  return (
    <div className="border-t border-line first:border-t-0" role="group" aria-label={rule.label} data-anyfilter-rule={rule.id}>
      <div className="flex items-center gap-2 py-1.5">
        <input
          type="checkbox"
          className="anyfilter-check"
          checked={rule.enabled}
          aria-label={t('settings.enabled')}
          onChange={(event) => onPatch({ enabled: event.target.checked })}
        />
        <input
          type="text"
          className="min-w-0 flex-1 bg-transparent px-0.5 py-0.5 font-bold text-ink"
          value={rule.label}
          maxLength={MAX_LABEL_LENGTH}
          aria-label={t('settings.ruleName')}
          onChange={(event) => onPatch({ label: event.target.value })}
        />
        <span className="flex-none rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-bold text-ink-2">
          {rule.kind === 'local' ? t('settings.local') : 'Jev'}
        </span>
        <span className="flex-none rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-bold text-ink-2">
          {rule.source === 'builtin' ? t('settings.sourceBuiltIn') : t('settings.sourceCustom')}
        </span>
        <button
          type="button"
          className="flex-none px-1 text-ink-2"
          aria-expanded={open}
          aria-label={open ? t('settings.closeRuleEditor') : t('settings.editRule')}
          onClick={onToggleOpen}
        >
          {open ? '✕' : t('settings.edit')}
        </button>
      </div>
      {open && <RuleEditor rule={rule} onPatch={onPatch} onDelete={onDelete} />}
    </div>
  );
}