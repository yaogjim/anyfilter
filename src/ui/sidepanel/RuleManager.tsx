import { useEffect, useRef, useState } from 'react';
import {
  validateRules,
  type PreviewInput,
  type PreviewResult,
  type Rule,
  type SaveRulesResult,
} from '../../domain/rule';
import { RulePreview } from './RulePreview';
import { RuleRow } from './RuleEditor';
import { newCustomRule, rulesEqual, withRule, withoutRule } from './rules-draft';
import { useLanguage } from '../language';

const BUTTON_CLASS = 'rounded-lg border border-[#cfd9de] bg-white px-3 py-1.5 font-bold';

type Message = { tone: 'ok' | 'error'; text: string };

export function RuleManager({
  rules,
  revision,
  threshold,
  onSaveRules,
  onPreview,
  onDirtyChange,
}: {
  rules: readonly Rule[];
  revision: number;
  threshold: number;
  onSaveRules: (rules: Rule[], expectedRevision: number) => Promise<SaveRulesResult>;
  onPreview: (input: PreviewInput) => Promise<PreviewResult>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { locale, t } = useLanguage();
  const [draft, setDraft] = useState<Rule[]>(() => [...rules]);
  // The revision the draft is based on. It only follows the saved revision while
  // there are no unsaved edits, so a save from another panel can never be
  // silently overwritten: saving a stale base reports a conflict instead.
  const [baseRevision, setBaseRevision] = useState(revision);
  const [openId, setOpenId] = useState<string | null>(() => rules.find((rule) => rule.kind === 'semantic')?.id ?? rules[0]?.id ?? null);
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<'all' | 'builtin' | 'custom'>('all');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // Counts user edits so a save that resolves late never clobbers newer input.
  const editSeq = useRef(0);
  const dirty = !rulesEqual(draft, rules);
  const selected = draft.find((rule) => rule.id === openId);
  const visibleRules = draft.filter((rule) =>
    (show === 'all' || rule.source === show) &&
    `${rule.label} ${rule.include} ${rule.exclude}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );

  useEffect(() => { setMessage(null); }, [locale]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Follow rules saved elsewhere while there is nothing unsaved here; keep the
  // draft (and its older base revision) once the user has edits.
  useEffect(() => {
    if (dirty) return;
    setDraft([...rules]);
    setBaseRevision(revision);
  }, [rules, revision, dirty]);

  const patch = (id: string, change: Partial<Rule>): void => {
    editSeq.current += 1;
    setDraft((current) => withRule(current, id, change));
  };

  const addRule = (): void => {
    editSeq.current += 1;
    const rule = newCustomRule(draft);
    setDraft((current) => [...current, rule]);
    setOpenId(rule.id);
    setShow('all');
    setSearch('');
    setMessage(null);
  };

  const deleteRule = (id: string): void => {
    editSeq.current += 1;
    setDraft((current) => withoutRule(current, id));
    setOpenId((current) => (current === id ? null : current));
    setMessage(null);
  };

  const save = (): void => {
    const validation = validateRules(draft);
    if (!validation.ok) {
      setMessage({ tone: 'error', text: validation.detail });
      return;
    }
    const submittedSeq = editSeq.current;
    setSaving(true);
    setMessage(null);
    void onSaveRules(validation.rules, baseRevision).then((result) => {
      setSaving(false);
      if (result.ok) {
        setConflict(false);
        // Rebase on the revision we just wrote. If the user kept editing while
        // the save was in flight, their newer draft stays instead of being
        // replaced by the response.
        setBaseRevision(result.settings.revision);
        if (editSeq.current === submittedSeq) {
          setDraft(result.settings.rules);
          setMessage({ tone: 'ok', text: t('settings.rulesSaved') });
        } else {
          setMessage({
            tone: 'ok',
            text: t('settings.rulesSavedWithNewerEdits'),
          });
        }
        return;
      }
      if (result.error === 'conflict') {
        setConflict(true);
        setMessage({
          tone: 'error',
          text: t('settings.rulesConflict'),
        });
        return;
      }
      setMessage({ tone: 'error', text: result.detail });
    }).catch((error: unknown) => {
      setSaving(false);
      const detail = error instanceof Error ? error.message : String(error);
      setMessage({
        tone: 'error',
        text: t('settings.rulesSaveFailed', { detail }),
      });
    });
  };

  const cancel = (): void => {
    setDraft([...rules]);
    setBaseRevision(revision);
    setConflict(false);
    setMessage(null);
  };

  const reload = (): void => {
    setDraft([...rules]);
    setBaseRevision(revision);
    setConflict(false);
    setMessage({ tone: 'ok', text: t('settings.rulesReloaded') });
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="m-0 text-lg font-bold text-ink">{t('settings.rules')}</h3>
          <p className="mt-1 text-xs text-ink-2">
            {t('settings.rulesIntro')}
          </p>
        </div>
        <button type="button" className="rounded-lg bg-ink px-3 py-2 font-bold text-white" onClick={addRule}>
          {t('settings.newRule')}
        </button>
      </div>
      <div className="grid items-start gap-4 @[700px]:grid-cols-[minmax(200px,260px)_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="space-y-2 border-b border-line p-3">
            <input
              type="search"
              aria-label={t('settings.searchRules')}
              placeholder={t('settings.searchRulesPlaceholder')}
              className="w-full rounded-lg border border-line px-3 py-2"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="flex gap-1" role="group" aria-label={t('settings.filterRules')}>
              {(['all', 'builtin', 'custom'] as const).map((source) => (
                <button
                  type="button"
                  key={source}
                  aria-pressed={show === source}
                  onClick={() => setShow(source)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-bold ${show === source ? 'bg-ink text-white' : 'bg-surface text-ink-2'}`}
                >
                  {source === 'all'
                    ? t('settings.sourceAll')
                    : source === 'builtin'
                      ? t('settings.sourceBuiltIn')
                      : t('settings.sourceCustom')}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-[32vh] space-y-1 overflow-y-auto overscroll-contain p-2 @[700px]:max-h-[70vh]" role="list" aria-label={t('settings.rules')}>
            {visibleRules.map((rule) => (
              <div key={rule.id} role="listitem" className={`flex items-center gap-2 rounded-lg px-2 py-1 ${openId === rule.id ? 'bg-surface' : 'hover:bg-surface'}`}>
                <input
                  type="checkbox"
                  aria-label={t('settings.enableRule', { name: rule.label })}
                  checked={rule.enabled}
                  onChange={(event) => patch(rule.id, { enabled: event.target.checked })}
                />
                <button
                  type="button"
                  data-rule-choice={rule.id}
                  aria-current={openId === rule.id ? 'true' : undefined}
                  onClick={() => setOpenId(rule.id)}
                  className="min-w-0 flex-1 py-2 text-left"
                >
                  <span className="block truncate text-sm font-semibold text-ink">{rule.label}</span>
                  <span className="text-[11px] text-ink-2">
                    {rule.kind === 'local' ? t('settings.kindOnPageCheck') : t('settings.kindJevQuestion')} ·{' '}
                    {rule.source === 'builtin' ? t('settings.sourceBuiltIn') : t('settings.sourceCustom')}
                  </span>
                </button>
              </div>
            ))}
            {visibleRules.length === 0 && (
              <p className="px-2 text-xs text-ink-2">{t('settings.noRulesMatch')}</p>
            )}
          </div>
        </div>
        <div className="min-w-0 rounded-xl border border-line bg-white p-4">
          {selected ? (
            <>
              <p className="m-0 mb-2 text-xs text-ink-2">
                {selected.kind === 'local'
                  ? t('settings.fixedLocalDetector')
                  : t('settings.describeMatchIntro')}
              </p>
              <RuleRow
                key={selected.id}
                rule={selected}
                open
                onToggleOpen={() => setOpenId(null)}
                onPatch={(change) => patch(selected.id, change)}
                onDelete={selected.source === 'custom' ? () => deleteRule(selected.id) : null}
              />
            </>
          ) : (
            <p className="m-0 text-ink-2">{t('settings.selectRuleHint')}</p>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-ink-2">
        {t('settings.builtInRulesNote')}
      </p>

      <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white/95 p-3 shadow-sm backdrop-blur">
        <button
          type="button"
          className="rounded-lg bg-ink px-3 py-1.5 font-bold text-white disabled:opacity-40"
          disabled={!dirty || saving}
          onClick={save}
        >
          {saving ? t('settings.saving') : t('settings.saveAndApply')}
        </button>
        <button type="button" className={BUTTON_CLASS} disabled={!dirty || saving} onClick={cancel}>
          {t('settings.cancel')}
        </button>
        {dirty && <span className="text-[11px] text-ink-2">{t('settings.unsavedChanges')}</span>}
      </div>
      <p className="mt-1 text-[11px] text-ink-2">
        {t('settings.saveRescoreNote')}
      </p>
      {message && (
        <p
          className={`m-0 mt-1.5 rounded-lg px-2.5 py-1.5 text-[12px] ${
            message.tone === 'ok' ? 'bg-surface text-keep' : 'bg-surface text-hide'
          }`}
        >
          {message.text}
          {conflict && (
            <button type="button" className="ml-2 underline" onClick={reload}>
              {t('settings.reload')}
            </button>
          )}
        </p>
      )}

      <section className="mt-6 rounded-xl border border-line bg-white p-4" aria-label={t('settings.testTextTitle')}>
        <h3 className="m-0 mb-2 text-lg font-bold text-ink">{t('settings.testTextTitle')}</h3>
        <p className="mb-4 text-xs text-ink-2">
          {t('settings.testDraftIntro')}
        </p>
        <RulePreview rules={draft} threshold={threshold} onPreview={onPreview} />
      </section>
    </>
  );
}