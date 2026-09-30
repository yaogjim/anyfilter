import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  validateRules,
  type PreviewInput,
  type PreviewResult,
  type Rule,
  type SaveRulesResult,
} from '../../domain/rule';
import { groupIdSet, validateGroups, type RuleGroup } from '../../domain/rule-group';
import { useLanguage } from '../language';
import { GroupManager } from './GroupManager';
import { groupLabel } from './group-label';
import {
  addGroup,
  findGroupByLabel,
  groupsEqual,
  moveGroup,
  removeGroup,
  renameGroup,
} from './groups-draft';
import { RuleDetail, type DetailTab } from './RuleDetail';
import { RuleList } from './RuleList';
import { ANY_GROUP, DEFAULT_QUERY, sectionKeyOf, type ListQuery } from './rule-list-model';
import { newCustomRule, rulesEqual, withRule, withoutRule } from './rules-draft';

const BUTTON_CLASS = 'min-h-9 rounded-lg border border-[#cfd9de] bg-white px-3 py-1.5 font-bold';

type Message = { tone: 'ok' | 'error'; text: string };

/** What the draft offers to a generator that wants to place a new rule: the
 * categories it may pick from and a way to name one that does not exist yet. */
export interface DraftHooks {
  groups: readonly RuleGroup[];
  /** The id of the category shown as `name`, making it in the draft if needed. */
  ensureGroup: (name: string) => string;
  /** Label for a category in the interface language. */
  labelOf: (group: RuleGroup) => string;
}

export function RuleManager({
  rules,
  groups,
  revision,
  threshold,
  onSaveRules,
  onPreview,
  onDirtyChange,
  renderAboveTabs,
}: {
  rules: readonly Rule[];
  groups: readonly RuleGroup[];
  revision: number;
  threshold: number;
  onSaveRules: (rules: Rule[], expectedRevision: number, groups: RuleGroup[]) => Promise<SaveRulesResult>;
  onPreview: (input: PreviewInput) => Promise<PreviewResult>;
  onDirtyChange?: (dirty: boolean) => void;
  /** Content shown above a selected rule's tabs, given the rule, a way to fill
   * it in and the draft's categories. The rule generator uses it for new rules. */
  renderAboveTabs?: (context: {
    rule: Rule;
    patch: (change: Partial<Rule>) => void;
    draft: readonly Rule[];
    hooks: DraftHooks;
  }) => ReactNode;
}) {
  const { locale, t } = useLanguage();
  const [draft, setDraft] = useState<Rule[]>(() => [...rules]);
  const [draftGroups, setDraftGroups] = useState<RuleGroup[]>(() => [...groups]);
  // The revision the draft is based on. It only follows the saved revision while
  // there are no unsaved edits, so a save from another panel can never be
  // silently overwritten: saving a stale base reports a conflict instead.
  const [baseRevision, setBaseRevision] = useState(revision);
  const [openId, setOpenId] = useState<string | null>(
    () => rules.find((rule) => rule.kind === 'semantic')?.id ?? rules[0]?.id ?? null,
  );
  // On a narrow container the list and the open rule take turns.
  const [stage, setStage] = useState<'list' | 'detail'>('list');
  const [query, setQuery] = useState<ListQuery>(DEFAULT_QUERY);
  const [tab, setTab] = useState<DetailTab>('definition');
  const [managing, setManaging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // Counts user edits so a save that resolves late never clobbers newer input.
  const editSeq = useRef(0);
  const dirty = !rulesEqual(draft, rules) || !groupsEqual(draftGroups, groups);
  const selected = draft.find((rule) => rule.id === openId);
  const labelOf = (group: RuleGroup): string => groupLabel(group, t);

  useEffect(() => {
    setMessage(null);
  }, [locale]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Follow rules saved elsewhere while there is nothing unsaved here; keep the
  // draft (and its older base revision) once the user has edits.
  useEffect(() => {
    if (dirty) return;
    setDraft([...rules]);
    setDraftGroups([...groups]);
    setBaseRevision(revision);
  }, [rules, groups, revision, dirty]);

  const edited = (): void => {
    editSeq.current += 1;
    setMessage(null);
  };

  const patch = (id: string, change: Partial<Rule>): void => {
    edited();
    setDraft((current) => withRule(current, id, change));
  };

  const addRule = (): void => {
    edited();
    // A new rule starts in the category being looked at, if there is one.
    const group = groupIdSet(draftGroups).has(query.group) ? query.group : undefined;
    const rule = newCustomRule(draft, group);
    setDraft((current) => [...current, rule]);
    setOpenId(rule.id);
    setStage('detail');
    setTab('definition');
    setQuery((current) => ({ ...current, search: '', source: 'all' }));
  };

  const deleteRule = (id: string): void => {
    edited();
    setDraft((current) => withoutRule(current, id));
    setOpenId((current) => (current === id ? null : current));
    setStage('list');
  };

  const choose = (id: string): void => {
    setOpenId(id);
    setStage('detail');
  };

  const setGroupEnabled = (key: string, enabled: boolean): void => {
    edited();
    const ids = groupIdSet(draftGroups);
    setDraft((current) =>
      current.map((rule) => (sectionKeyOf(rule, ids) === key && rule.enabled !== enabled ? { ...rule, enabled } : rule)),
    );
  };

  const addCategory = (name: string): void => {
    edited();
    setDraftGroups((current) => addGroup(current, name).groups);
  };

  const renameCategory = (id: string, name: string): void => {
    edited();
    setDraftGroups((current) => renameGroup(current, id, name));
  };

  const deleteCategory = (id: string): void => {
    edited();
    const removed = removeGroup(draftGroups, draft, id);
    setDraftGroups(removed.groups);
    setDraft(removed.rules);
    // A filter on a category that is gone would show an empty list.
    setQuery((current) => (current.group === id ? { ...current, group: ANY_GROUP } : current));
  };

  const moveCategory = (id: string, delta: -1 | 1): void => {
    edited();
    setDraftGroups((current) => moveGroup(current, id, delta));
  };

  const createCategoryFor = (ruleId: string, name: string): void => {
    edited();
    const added = addGroup(draftGroups, name);
    setDraftGroups(added.groups);
    setDraft((current) => withRule(current, ruleId, { group: added.id }));
  };

  // For a generator: the id of the category shown as `name`, made in the draft
  // when there is none. Returns at once, so the new id can go straight into the
  // rule being filled in.
  const ensureGroup = (name: string): string => {
    const found = findGroupByLabel(draftGroups, name, labelOf);
    if (found !== undefined) return found.id;
    edited();
    const added = addGroup(draftGroups, name);
    setDraftGroups(added.groups);
    return added.id;
  };

  const save = (): void => {
    const checkedGroups = validateGroups(draftGroups);
    if (!checkedGroups.ok) {
      setMessage({ tone: 'error', text: checkedGroups.detail });
      return;
    }
    const validation = validateRules(draft, groupIdSet(checkedGroups.groups));
    if (!validation.ok) {
      setMessage({ tone: 'error', text: validation.detail });
      return;
    }
    const submittedSeq = editSeq.current;
    setSaving(true);
    setMessage(null);
    void onSaveRules(validation.rules, baseRevision, checkedGroups.groups)
      .then((result) => {
        setSaving(false);
        if (result.ok) {
          setConflict(false);
          // Rebase on the revision we just wrote. If the user kept editing while
          // the save was in flight, their newer draft stays instead of being
          // replaced by the response.
          setBaseRevision(result.settings.revision);
          if (editSeq.current === submittedSeq) {
            setDraft(result.settings.rules);
            setDraftGroups(result.settings.ruleGroups);
            setMessage({ tone: 'ok', text: t('settings.rulesSaved') });
          } else {
            setMessage({ tone: 'ok', text: t('settings.rulesSavedWithNewerEdits') });
          }
          return;
        }
        if (result.error === 'conflict') {
          setConflict(true);
          setMessage({ tone: 'error', text: t('settings.rulesConflict') });
          return;
        }
        setMessage({ tone: 'error', text: result.detail });
      })
      .catch((error: unknown) => {
        setSaving(false);
        const detail = error instanceof Error ? error.message : String(error);
        setMessage({ tone: 'error', text: t('settings.rulesSaveFailed', { detail }) });
      });
  };

  const discard = (): void => {
    setDraft([...rules]);
    setDraftGroups([...groups]);
    setBaseRevision(revision);
    setConflict(false);
  };

  const cancel = (): void => {
    discard();
    setMessage(null);
  };

  const reload = (): void => {
    discard();
    setMessage({ tone: 'ok', text: t('settings.rulesReloaded') });
  };

  // A narrow screen has nothing to show for a rule that is gone (deleted, or a
  // new rule that was cancelled), so it goes back to the list.
  const openExists = openId !== null && draft.some((rule) => rule.id === openId);
  useEffect(() => {
    if (stage === 'detail' && !openExists) setStage('list');
  }, [stage, openExists]);

  const hooks: DraftHooks = { groups: draftGroups, ensureGroup, labelOf };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="m-0 text-lg font-bold text-ink">{t('settings.rules')}</h3>
          <p className="mt-1 text-xs text-ink-2">{t('settings.rulesIntro')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BUTTON_CLASS}
            aria-expanded={managing}
            data-anyfilter-groups="toggle"
            onClick={() => setManaging((current) => !current)}
          >
            {t('settings.manageCategories')}
          </button>
          <button
            type="button"
            className="min-h-9 rounded-lg bg-ink px-3 py-2 font-bold text-white"
            onClick={addRule}
          >
            {t('settings.newRule')}
          </button>
        </div>
      </div>
      {managing && (
        <div className="mb-4">
          <GroupManager
            groups={draftGroups}
            rules={draft}
            onAdd={addCategory}
            onRename={renameCategory}
            onDelete={deleteCategory}
            onMove={moveCategory}
            onClose={() => setManaging(false)}
          />
        </div>
      )}
      <div className="grid items-start gap-4 @[700px]:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]">
        <div className={stage === 'detail' ? 'hidden @[700px]:block' : undefined}>
          <RuleList
            rules={draft}
            groups={draftGroups}
            query={query}
            onQuery={(change) => setQuery((current) => ({ ...current, ...change }))}
            selectedId={openId}
            onSelect={choose}
            onToggle={(id, enabled) => patch(id, { enabled })}
            onSetGroupEnabled={setGroupEnabled}
          />
        </div>
        <div className={`min-w-0 rounded-xl border border-line bg-white p-4 ${stage === 'list' ? 'hidden @[700px]:block' : ''}`}>
          <button
            type="button"
            className="mb-3 min-h-9 rounded-lg border border-line px-2.5 text-xs font-bold text-ink-2 hover:bg-surface @[700px]:hidden"
            onClick={() => setStage('list')}
          >
            ← {t('settings.backToRules')}
          </button>
          {selected ? (
            <RuleDetail
              key={selected.id}
              rule={selected}
              rules={draft}
              groups={draftGroups}
              threshold={threshold}
              tab={tab}
              onTab={setTab}
              onPatch={(change) => patch(selected.id, change)}
              onDelete={selected.source === 'custom' ? () => deleteRule(selected.id) : null}
              onCreateGroup={(name) => createCategoryFor(selected.id, name)}
              onPreview={onPreview}
              aboveTabs={
                renderAboveTabs?.({
                  rule: selected,
                  patch: (change) => patch(selected.id, change),
                  draft,
                  hooks,
                }) ?? null
              }
            />
          ) : (
            <p className="m-0 text-ink-2">{t('settings.selectRuleHint')}</p>
          )}
        </div>
      </div>

      <div className="sticky bottom-0 z-10 mt-4 rounded-xl border border-line bg-white/95 p-3 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="min-h-9 rounded-lg bg-ink px-3 py-1.5 font-bold text-white disabled:opacity-40"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? t('settings.saving') : t('settings.saveAndApply')}
          </button>
          <button type="button" className={BUTTON_CLASS} disabled={!dirty || saving} onClick={cancel}>
            {t('settings.cancel')}
          </button>
          {dirty && (
            <span className="text-[11px] font-semibold text-ink-2" role="status" data-anyfilter-rules="dirty">
              {t('settings.unsavedChanges')}
            </span>
          )}
        </div>
        <p className="m-0 mt-1.5 text-[11px] text-ink-2">
          {t('settings.saveRescoreNote')} {t('settings.builtInRulesNote')}
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
      </div>
    </>
  );
}

