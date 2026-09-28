import { useEffect, useState } from 'react';
import { PROVIDERS } from '../../domain/provider';
import type { PostKind } from '../../domain/post';
import type { PreviewInput, PreviewResult, Rule, SaveRulesResult } from '../../domain/rule';
import type { Settings } from '../../domain/settings';
import { RuleManager } from './RuleManager';

const INPUT_CLASS = 'w-full rounded-lg border border-[#cfd9de] bg-white px-2 py-1.5 text-[13px]';
const SUBHEADING_CLASS = 'mb-2 text-[15px] font-bold text-ink';
const BUTTON_CLASS = 'rounded-lg border border-[#cfd9de] bg-white px-3 py-1.5 font-bold';

export function SettingsSection({
  settings,
  onChange,
  onClearData,
  onClearHidden,
  onSaveRules,
  onPreview,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClearData: () => Promise<void>;
  onClearHidden: (kind: PostKind) => Promise<void>;
  onSaveRules: (rules: Rule[], expectedRevision: number) => Promise<SaveRulesResult>;
  onPreview: (input: PreviewInput) => Promise<PreviewResult>;
}) {
  const provider = PROVIDERS.find((candidate) => candidate.id === settings.provider) ?? PROVIDERS[0];
  const [rulesDirty, setRulesDirty] = useState(false);

  // Closing or reloading the options tab would drop an unsaved rule draft.
  useEffect(() => {
    if (!rulesDirty) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [rulesDirty]);

  return (
    <div className="space-y-8">
      <section id="provider" className="scroll-mt-24">
        <h2 className={SUBHEADING_CLASS}>Provider</h2>
        <div className="flex rounded-lg bg-surface p-0.5" role="radiogroup" aria-label="Provider">
          {PROVIDERS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={candidate.id === settings.provider}
              className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition ${
                candidate.id === settings.provider
                  ? 'bg-white text-ink shadow-sm'
                  : 'text-ink-2 hover:text-ink'
              }`}
              onClick={() => onChange({ provider: candidate.id })}
            >
              {candidate.label}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="anyfilter-key">
          API key
        </label>
        <input
          id="anyfilter-key"
          type="password"
          className={`${INPUT_CLASS} mt-1.5`}
          placeholder={`${provider.keyHint} — stored only in this browser`}
          value={settings.keys[settings.provider]}
          onChange={(event) =>
            onChange({ keys: { ...settings.keys, [settings.provider]: event.target.value } })
          }
        />
        <p className="mt-1 text-[11px] text-ink-2">
          Your key never leaves this browser except to the provider you picked. Without a key only
          ads are hidden.
        </p>
      </section>

      <section id="threshold" className="scroll-mt-24">
        <h2 className={SUBHEADING_CLASS}>Threshold</h2>
        <label className="block">
          <span className="text-ink-2">
            Hide a post when the model's probability is at least{' '}
            <b className="text-ink tabular-nums">{Math.round(settings.threshold * 100)}%</b>
          </span>
          <input
            type="range"
            className="anyfilter-range mt-1 w-full"
            min={50}
            max={95}
            step={5}
            value={Math.round(settings.threshold * 100)}
            onChange={(event) => onChange({ threshold: Number(event.target.value) / 100 })}
          />
          <span className="flex justify-between text-[11px] text-ink-2">
            <span>Hide more</span>
            <span>Hide less</span>
          </span>
        </label>
        <p className="mt-1 text-[11px] text-ink-2">
          This is the model's probability for a rule, not an accuracy rate. Rules whose wording is
          vague will score less reliably.
        </p>
      </section>

      <section id="rules" className="scroll-mt-24">
        <RuleManager
          rules={settings.rules}
          revision={settings.revision}
          threshold={settings.threshold}
          onSaveRules={onSaveRules}
          onPreview={onPreview}
          onDirtyChange={setRulesDirty}
        />
      </section>

      <section id="data" className="scroll-mt-24">
        <h2 className={SUBHEADING_CLASS}>Data</h2>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={BUTTON_CLASS} onClick={() => void onClearHidden('post')}>
            Clear hidden posts
          </button>
          <button type="button" className={BUTTON_CLASS} onClick={() => void onClearHidden('reply')}>
            Clear hidden replies
          </button>
          <button type="button" className={BUTTON_CLASS} onClick={() => void onClearData()}>
            Clear everything
          </button>
        </div>
        <p className="mt-1 text-[11px] text-ink-2">
          Clearing everything also resets the counters and forgets cached scores. Settings, rules and
          your key stay.
        </p>
      </section>
    </div>
  );
}