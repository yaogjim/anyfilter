import { useState } from 'react';
import { modelsOf, type EvaluationConnections } from '../../domain/evaluation-pricing';
import type { MachineLabellerId } from '../../domain/machine-label';
import type { KeyPresence } from '../../infrastructure/evaluation-keys';
import { useLanguage } from '../language';
import type { PanelGateway } from './PanelGateway';

/**
 * The key and connection fields for the OpenAI and DeepSeek labellers. They are
 * shared by every place that sets them up (today the settings page), and they
 * keep the `data-anyfilter-evaluation` hooks and the storage they always had:
 * a key is set or cleared through the background and is never read back, and a
 * connection is validated by the background before it is stored.
 */

const BUTTON_CLASS =
  'min-h-9 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50';
const MUTED_CLASS = 'text-xs text-ink-2';

export function ConnectionRow({
  labeller,
  connections,
  gateway,
  onConnections,
}: {
  labeller: MachineLabellerId;
  connections: EvaluationConnections;
  gateway: PanelGateway;
  onConnections: (next: EvaluationConnections) => void;
}) {
  const { t } = useLanguage();
  const saved = connections[labeller];
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl);
  const [model, setModel] = useState(saved.model);
  const [invalid, setInvalid] = useState(false);
  const dirty = baseUrl.trim() !== saved.baseUrl || model !== saved.model;

  const store = (): void => {
    setInvalid(false);
    void gateway.setEvaluationConnection(labeller, baseUrl, model).then((result) => {
      if (result === null || !result.ok) {
        setInvalid(true);
        return;
      }
      onConnections(result.connections);
      setBaseUrl(result.connections[labeller].baseUrl);
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 pl-1" data-anyfilter-evaluation={`connection-${labeller}`}>
      <label className="flex items-center gap-1.5 text-xs text-ink-2">
        <span>{t('evaluation.connection.model')}</span>
        <select
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className="min-h-9 rounded-lg border border-line px-1.5 text-xs"
          data-anyfilter-evaluation="connection-model"
        >
          {modelsOf(labeller).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-ink-2">
        <span>{t('evaluation.connection.baseUrl')}</span>
        <input
          type="url"
          autoComplete="off"
          spellCheck={false}
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-line px-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          data-anyfilter-evaluation="connection-url"
        />
      </label>
      <button
        type="button"
        className={BUTTON_CLASS}
        disabled={!dirty}
        onClick={store}
        data-anyfilter-evaluation="connection-save"
      >
        {t('evaluation.connection.save')}
      </button>
      {invalid && (
        <span role="alert" className="w-full text-xs text-[#a32020]">
          {t('evaluation.connection.invalid')}
        </span>
      )}
    </div>
  );
}

export function KeyRow({
  labeller,
  present,
  gateway,
  onPresence,
}: {
  labeller: MachineLabellerId;
  present: boolean;
  gateway: PanelGateway;
  onPresence: (keys: KeyPresence) => void;
}) {
  const { t } = useLanguage();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const label = labeller === 'openai' ? t('evaluation.keys.openai') : t('evaluation.keys.deepseek');

  const store = (next: string): void => {
    setInvalid(false);
    void gateway.setEvaluationKey(labeller, next).then((result) => {
      if (result === null || !result.ok) {
        setInvalid(true);
        return;
      }
      setValue('');
      onPresence(result.keys);
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-anyfilter-evaluation={`key-${labeller}`}>
      <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-ink-2">
        <span className="w-24 shrink-0 font-semibold text-ink">{label}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={t('evaluation.keys.placeholder')}
          onChange={(event) => setValue(event.target.value)}
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-line px-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        />
      </label>
      <span className={MUTED_CLASS} data-anyfilter-evaluation="key-state">
        {present ? t('evaluation.keys.set') : t('evaluation.keys.missing')}
      </span>
      <button type="button" className={BUTTON_CLASS} disabled={value.trim() === ''} onClick={() => store(value)}>
        {t('evaluation.keys.save')}
      </button>
      <button type="button" className={BUTTON_CLASS} disabled={!present} onClick={() => store('')}>
        {t('evaluation.keys.clear')}
      </button>
      {invalid && (
        <span role="alert" className="w-full text-xs text-[#a32020]">
          {t('evaluation.keys.invalid')}
        </span>
      )}
    </div>
  );
}
