import { useEffect, useId, useState } from 'react';
import { MODEL_CATALOG, type EvaluationConnections } from '../../domain/evaluation-pricing';
import type { MachineLabellerId } from '../../domain/machine-label';
import type { Settings } from '../../domain/settings';
import type { KeyPresence } from '../../infrastructure/evaluation-keys';
import { useLanguage } from '../language';
import { ConnectionRow, KeyRow } from './ConnectionFields';
import type { PanelGateway } from './PanelGateway';
import { panelId, tabId, TabStrip } from './TabStrip';

const BUTTON_CLASS =
  'min-h-9 rounded-lg border border-[#cfd9de] bg-white px-3 py-1.5 text-[12px] font-bold hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

/** The machine connections that can draft a rule: one per labeller that has a
 * priced model, in catalog order. */
const ASSISTANTS: readonly MachineLabellerId[] = [
  ...new Set(MODEL_CATALOG.map((entry) => entry.labeller)),
];

/** The helper model that drafts a rule from a description. It is the same
 * OpenAI/DeepSeek key and connection the Verify page evaluates with, set here
 * once. Keys are set or cleared through the background and never shown again;
 * which connection drafts rules is the one `assistant` setting. */
export function AssistantTabs({
  gateway,
  settings,
  onChange,
}: {
  gateway: PanelGateway;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const { t } = useLanguage();
  const idBase = useId();
  const [viewed, setViewed] = useState<MachineLabellerId>(settings.assistant);
  const [keys, setKeys] = useState<KeyPresence | null>(null);
  const [connections, setConnections] = useState<EvaluationConnections | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([gateway.loadKeyPresence(), gateway.loadEvaluationConnections()]).then(
      ([nextKeys, nextConnections]) => {
        if (!active) return;
        if (nextKeys === null || nextConnections === null) {
          setFailed(true);
          return;
        }
        setKeys(nextKeys);
        setConnections(nextConnections);
      },
    );
    return () => {
      active = false;
    };
  }, [gateway]);

  const labelOf = (id: MachineLabellerId): string =>
    id === 'openai' ? t('settings.assistantOpenai') : t('settings.assistantDeepseek');
  const inUse = viewed === settings.assistant;

  return (
    <div>
      <p className="mb-2 mt-0 text-[11px] text-ink-2">{t('settings.assistantIntro')}</p>
      <TabStrip
        idBase={idBase}
        label={t('settings.assistantTabs')}
        selected={viewed}
        onSelect={(id) => setViewed(id as MachineLabellerId)}
        items={ASSISTANTS.map((id) => ({
          id,
          label: labelOf(id),
          inUse: id === settings.assistant,
          keySet: keys?.[id] === true,
        }))}
      />
      <div
        role="tabpanel"
        id={panelId(idBase)}
        aria-labelledby={tabId(idBase, viewed)}
        className="mt-2 flex flex-col gap-1.5"
        data-anyfilter-assistant="panel"
      >
        {keys === null || connections === null ? (
          <p className="m-0 text-xs text-ink-2" role={failed ? 'alert' : 'status'}>
            {failed ? t('settings.assistantLoadFailed') : t('shell.loading')}
          </p>
        ) : (
          <>
            {/* Keyed by connection so a tab switch never carries a half-typed key across. */}
            <KeyRow key={`key-${viewed}`} labeller={viewed} present={keys[viewed]} gateway={gateway} onPresence={setKeys} />
            <ConnectionRow
              key={`connection-${viewed}`}
              labeller={viewed}
              connections={connections}
              gateway={gateway}
              onConnections={setConnections}
            />
            <p className="m-0 text-[11px] text-ink-2">{t('evaluation.keys.note')}</p>
            <div className="mt-1 flex items-center gap-2">
              {inUse ? (
                <span className="text-[12px] font-semibold text-ink-2" data-anyfilter-assistant="in-use">
                  {t('settings.assistantInUse')}
                </span>
              ) : (
                <button
                  type="button"
                  className={BUTTON_CLASS}
                  data-anyfilter-assistant="use"
                  onClick={() => onChange({ assistant: viewed })}
                >
                  {t('settings.useAssistant')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
