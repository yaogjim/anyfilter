import { useEffect, useId, useRef, useState } from 'react';
import type { EvaluationConnections } from '../../domain/evaluation-pricing';
import type { MachineLabellerId } from '../../domain/machine-label';
import type { Rule } from '../../domain/rule';
import {
  MAX_REQUIREMENT_LENGTH,
  requirementProblem,
  uniqueRuleLabel,
  type GeneratedRuleDraft,
  type GenerateRuleError,
} from '../../domain/rule-draft';
import type { KeyPresence } from '../../infrastructure/evaluation-keys';
import { useLanguage, type TranslationKey } from '../language';
import { checkGroupName, findGroupByLabel } from './groups-draft';
import type { PanelGateway } from './PanelGateway';
import type { DraftHooks } from './RuleManager';

const ERROR_TEXT: Record<GenerateRuleError, TranslationKey> = {
  'no-key': 'settings.generate.errorNoKey',
  auth: 'settings.generate.errorAuth',
  'rate-limited': 'settings.generate.errorRateLimited',
  network: 'settings.generate.errorNetwork',
  'bad-response': 'settings.generate.errorBadResponse',
  invalid: 'settings.generate.errorInvalid',
};

type Notice =
  | { tone: 'ok'; model: string; categoryFull: boolean }
  | { tone: 'error'; error: GenerateRuleError; detail: string };

/** What the editor needs from the rule being filled in. Read through a ref when a
 * draft arrives, because the answer lands long after the render that asked. */
interface Latest {
  rule: Rule;
  patch: (change: Partial<Rule>) => void;
  draft: readonly Rule[];
  hooks: DraftHooks;
}

/**
 * Drafts the open new rule from a plain-language requirement.
 *
 * It asks only when the person clicks, sends one request through the background
 * (which owns the key) and puts the answer into the form. It never saves: the
 * rule stays an unsaved draft for the person to read and change. A late answer
 * for an older click, or for a rule that has been left, is ignored.
 */
export function RuleGenerator({
  gateway,
  assistant,
  rule,
  patch,
  draft,
  hooks,
}: {
  gateway: PanelGateway;
  assistant: MachineLabellerId;
  rule: Rule;
  patch: (change: Partial<Rule>) => void;
  draft: readonly Rule[];
  hooks: DraftHooks;
}) {
  const { t } = useLanguage();
  const fieldId = useId();
  const [requirement, setRequirement] = useState('');
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [keys, setKeys] = useState<KeyPresence | null>(null);
  const [connections, setConnections] = useState<EvaluationConnections | null>(null);
  const latest = useRef<Latest>({ rule, patch, draft, hooks });
  latest.current = { rule, patch, draft, hooks };
  const request = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, []);

  const refresh = (): void => {
    void Promise.all([gateway.loadKeyPresence(), gateway.loadEvaluationConnections()]).then(
      ([nextKeys, nextConnections]) => {
        if (!mounted.current) return;
        setKeys(nextKeys);
        setConnections(nextConnections);
      },
    );
  };

  // The key is set in another card on this page, so look again when the assistant
  // changes, when the window comes back, and when the person reaches for this card.
  useEffect(refresh, [gateway, assistant]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  });

  const problem = requirementProblem(requirement);
  const hasKey = keys === null ? null : keys[assistant];
  const model = connections?.[assistant].model ?? '';
  const filled = notice?.tone === 'ok';
  const canGenerate = !running && hasKey === true && problem === null;

  const apply = (result: GeneratedRuleDraft): boolean => {
    const { rule: current, patch: fill, draft: rules, hooks: offered } = latest.current;
    const change: Partial<Rule> = {
      label: uniqueRuleLabel(
        result.label,
        rules.filter((other) => other.id !== current.id).map((other) => other.label),
      ),
      include: result.include,
      exclude: result.exclude,
      examplesYes: result.examplesYes,
      examplesNo: result.examplesNo,
      scope: result.scope,
    };
    let categoryFull = false;
    const name = result.groupName ?? result.newGroupName;
    if (name !== undefined) {
      const found = findGroupByLabel(offered.groups, name, offered.labelOf);
      if (found !== undefined) change.group = found.id;
      else if (checkGroupName(name, offered.groups, offered.labelOf) === null) change.group = offered.ensureGroup(name);
      else categoryFull = true;
    }
    fill(change);
    return categoryFull;
  };

  const generate = (): void => {
    if (!canGenerate) return;
    request.current += 1;
    const mine = request.current;
    setRunning(true);
    void gateway
      .generateRule({
        requirement,
        groupNames: latest.current.hooks.groups.map(latest.current.hooks.labelOf).filter((name) => name !== ''),
      })
      .catch(
        (error: unknown) =>
          ({
            ok: false,
            error: 'network',
            detail: error instanceof Error ? error.message : String(error),
          }) as const,
      )
      .then((result) => {
        if (!mounted.current || request.current !== mine) return;
        setRunning(false);
        if (!result.ok) {
          // The form is left exactly as it was.
          setNotice({ tone: 'error', error: result.error, detail: result.detail });
          return;
        }
        const categoryFull = apply(result.draft);
        setNotice({ tone: 'ok', model: result.model, categoryFull });
      });
  };

  return (
    <section
      className="mb-4 rounded-xl border border-line bg-surface/60 p-3"
      data-anyfilter-generator="section"
      onPointerEnter={refresh}
    >
      <h4 className="m-0 text-[13px] font-bold text-ink">{t('settings.generate.title')}</h4>
      <p className="mb-2 mt-0.5 text-[11px] text-ink-2">{t('settings.generate.intro')}</p>
      <label className="block" htmlFor={fieldId}>
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-ink-2">
          {t('settings.generate.requirement')}
        </span>
      </label>
      <textarea
        id={fieldId}
        className="min-h-[72px] w-full rounded-lg border border-[#cfd9de] bg-white px-2 py-1.5 text-[13px]"
        data-anyfilter-generator="requirement"
        value={requirement}
        maxLength={MAX_REQUIREMENT_LENGTH}
        placeholder={t('settings.generate.placeholder')}
        onChange={(event) => setRequirement(event.target.value)}
      />
      <div className="mt-0.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-2">
        <span data-anyfilter-generator="model">{model !== '' && t('settings.generate.model', { model })}</span>
        <span className="tabular-nums">
          {t('settings.generate.count', { count: requirement.length, max: MAX_REQUIREMENT_LENGTH })}
        </span>
      </div>
      {problem === 'too-long' && <p className="m-0 mt-1 text-[11px] text-hide">{t('settings.generate.tooLong')}</p>}
      {problem === 'unsafe' && <p className="m-0 mt-1 text-[11px] text-hide">{t('settings.generate.unsafe')}</p>}
      <p className="m-0 mt-1 text-[11px] text-ink-2">{t('settings.generate.sendsNote')}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="min-h-9 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40"
          data-anyfilter-generator="generate"
          disabled={!canGenerate}
          onClick={generate}
        >
          {running
            ? t('settings.generate.running')
            : filled
              ? t('settings.generate.again')
              : t('settings.generate.button')}
        </button>
        {hasKey === false && (
          <span className="text-[11px] text-ink-2" data-anyfilter-generator="no-key">
            {t('settings.generate.noKey')}{' '}
            <a className="font-bold text-ink underline" href="#models">
              {t('settings.generate.noKeyLink')}
            </a>
          </span>
        )}
        {hasKey === null && <span className="text-[11px] text-ink-2">{t('settings.generate.keyUnknown')}</span>}
      </div>
      <div aria-live="polite">
        {notice?.tone === 'ok' && (
          <p
            className="m-0 mt-2 rounded-lg bg-white px-2.5 py-1.5 text-[12px] text-keep"
            data-anyfilter-generator="filled"
          >
            {t('settings.generate.filled', { model: notice.model })}
            {notice.categoryFull && <> {t('settings.generate.categoryFull')}</>}
          </p>
        )}
        {notice?.tone === 'error' && (
          <p
            className="m-0 mt-2 rounded-lg bg-white px-2.5 py-1.5 text-[12px] text-hide"
            role="alert"
            data-anyfilter-generator="error"
          >
            {t(ERROR_TEXT[notice.error], { detail: notice.detail })}
          </p>
        )}
      </div>
    </section>
  );
}
