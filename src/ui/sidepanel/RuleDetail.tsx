import { useId, useState, type ReactNode } from 'react';
import {
  MAX_LABEL_LENGTH,
  type PreviewInput,
  type PreviewResult,
  type Rule,
} from '../../domain/rule';
import { MAX_GROUP_NAME_LENGTH, type RuleGroup } from '../../domain/rule-group';
import { useLanguage } from '../language';
import { problemText } from './GroupManager';
import { groupLabel, uncategorisedLabel } from './group-label';
import { checkGroupName, type GroupNameProblem } from './groups-draft';
import { DefinitionPanel, ExamplesPanel } from './RuleEditor';
import { RulePreview } from './RulePreview';
import { UNCATEGORISED } from './rule-list-model';
import { panelId, tabId, TabStrip, type TabItem } from './TabStrip';

export type DetailTab = 'definition' | 'examples' | 'test';

const INPUT_CLASS = 'w-full rounded-lg border border-[#cfd9de] bg-white px-2 py-1.5 text-[13px]';
const SMALL_BUTTON_CLASS =
  'min-h-9 rounded-lg border border-[#cfd9de] bg-white px-2.5 py-1 text-xs font-bold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';
const FIELD_LABEL_CLASS = 'mb-1 block text-[11px] font-bold uppercase tracking-wide text-ink-2';
const NEW_CATEGORY = '__new__';

/** The category picker. The last option makes a new category on the spot, so a
 * rule never has to be left half-edited to go and create one. */
function CategoryField({
  rule,
  groups,
  onChange,
  onCreate,
}: {
  rule: Rule;
  groups: readonly RuleGroup[];
  onChange: (group: string | null) => void;
  onCreate: (name: string) => void;
}) {
  const { t } = useLanguage();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<GroupNameProblem | null>(null);
  const known = rule.group !== undefined && groups.some((group) => group.id === rule.group);

  const create = (): void => {
    const found = checkGroupName(name, groups, (g) => groupLabel(g, t));
    if (found !== null) {
      setProblem(found);
      return;
    }
    onCreate(name.trim());
    setCreating(false);
    setName('');
    setProblem(null);
  };

  return (
    <div>
      <label className="block">
        <span className={FIELD_LABEL_CLASS}>{t('settings.category')}</span>
        <select
          className={INPUT_CLASS}
          value={creating ? NEW_CATEGORY : known ? rule.group : UNCATEGORISED}
          onChange={(event) => {
            if (event.target.value === NEW_CATEGORY) {
              setCreating(true);
              return;
            }
            setCreating(false);
            setProblem(null);
            onChange(event.target.value === UNCATEGORISED ? null : event.target.value);
          }}
        >
          <option value={UNCATEGORISED}>{uncategorisedLabel(t)}</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {groupLabel(group, t)}
            </option>
          ))}
          <option value={NEW_CATEGORY}>{t('settings.newCategoryOption')}</option>
        </select>
      </label>
      {creating && (
        <div className="mt-1.5 flex flex-wrap items-start gap-1.5">
          <div className="min-w-0 flex-1">
            <input
              type="text"
              autoFocus
              className={INPUT_CLASS}
              value={name}
              maxLength={MAX_GROUP_NAME_LENGTH}
              placeholder={t('settings.newCategoryPlaceholder')}
              aria-label={t('settings.newCategoryPlaceholder')}
              aria-invalid={problem !== null}
              onChange={(event) => {
                setName(event.target.value);
                setProblem(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  create();
                }
              }}
            />
            {problem !== null && (
              <p role="alert" className="m-0 mt-1 text-[11px] text-hide">
                {problemText(problem, t)}
              </p>
            )}
          </div>
          <button type="button" className={SMALL_BUTTON_CLASS} onClick={create}>
            {t('settings.addCategory')}
          </button>
          <button
            type="button"
            className={SMALL_BUTTON_CLASS}
            aria-label={t('settings.discardNewCategory')}
            onClick={() => {
              setCreating(false);
              setName('');
              setProblem(null);
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

/** One rule, opened for editing: its name and category up top, then three tabs.
 * The panels stay mounted and are only hidden, so a half-written test text
 * survives a look at another tab. Everything edits the draft. */
export function RuleDetail({
  rule,
  rules,
  groups,
  threshold,
  tab,
  onTab,
  onPatch,
  onDelete,
  onCreateGroup,
  onPreview,
  aboveTabs,
}: {
  rule: Rule;
  /** The whole draft, which the test runs against. */
  rules: readonly Rule[];
  groups: readonly RuleGroup[];
  threshold: number;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  onPatch: (patch: Partial<Rule>) => void;
  onDelete: (() => void) | null;
  /** Makes a category with this name and puts this rule in it. */
  onCreateGroup: (name: string) => void;
  onPreview: (input: PreviewInput) => Promise<PreviewResult>;
  /** Extra content between the header and the tabs (the rule generator). */
  aboveTabs?: ReactNode;
}) {
  const { t } = useLanguage();
  const idBase = useId();
  const items: TabItem[] = [
    { id: 'definition', label: t('settings.tabDefinition') },
    ...(rule.kind === 'semantic' ? [{ id: 'examples', label: t('settings.tabExamples') }] : []),
    { id: 'test', label: t('settings.tabTest') },
  ];
  const active: DetailTab = items.some((item) => item.id === tab) ? tab : 'definition';

  return (
    <div
      className="@container space-y-3"
      role="group"
      aria-label={rule.label}
      data-anyfilter-rule={rule.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          className="anyfilter-check"
          checked={rule.enabled}
          aria-label={t('settings.enabled')}
          onChange={(event) => onPatch({ enabled: event.target.checked })}
        />
        <input
          type="text"
          className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1.5 py-1 text-[15px] font-bold text-ink hover:border-line focus:border-[#cfd9de]"
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
        {onDelete && (
          <button type="button" className={`${SMALL_BUTTON_CLASS} text-hide`} onClick={onDelete}>
            {t('settings.deleteRule')}
          </button>
        )}
      </div>

      <CategoryField
        rule={rule}
        groups={groups}
        onChange={(group) => onPatch({ group: group ?? undefined })}
        onCreate={onCreateGroup}
      />

      {aboveTabs}

      <div>
        <TabStrip
          idBase={idBase}
          label={t('settings.ruleTabs')}
          items={items}
          selected={active}
          onSelect={(id) => onTab(id as DetailTab)}
        />
        <div
          role="tabpanel"
          id={panelId(idBase)}
          aria-labelledby={tabId(idBase, active)}
          className="mt-3"
        >
          <div hidden={active !== 'definition'}>
            <DefinitionPanel rule={rule} onPatch={onPatch} />
          </div>
          <div hidden={active !== 'examples'}>
            <ExamplesPanel rule={rule} onPatch={onPatch} />
          </div>
          <div hidden={active !== 'test'}>
            <p className="mb-3 mt-0 text-xs text-ink-2">{t('settings.testDraftIntro')}</p>
            <RulePreview rules={rules} threshold={threshold} onPreview={onPreview} />
          </div>
        </div>
      </div>
    </div>
  );
}
