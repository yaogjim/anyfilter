import { useMemo, useState } from 'react';
import type { Rule } from '../../domain/rule';
import type { RuleGroup } from '../../domain/rule-group';
import { useLanguage } from '../language';
import { groupLabel, uncategorisedLabel } from './group-label';
import {
  ANY_GROUP,
  UNCATEGORISED,
  buildRuleList,
  type ListQuery,
  type RuleSection,
  type SortMode,
  type SourceFilter,
} from './rule-list-model';

const SELECT_CLASS =
  'min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-white px-2 py-1 text-xs text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

/** One rule's row. Turning it on or off and opening it are two separate
 * controls, so flipping a rule never changes which one is being edited. */
function RuleItem({
  rule,
  selected,
  onSelect,
  onToggle,
}: {
  rule: Rule;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const { t } = useLanguage();
  return (
    <div
      role="listitem"
      className={`flex items-center gap-2 rounded-lg px-2 py-1 ${selected ? 'bg-surface' : 'hover:bg-surface'}`}
    >
      <input
        type="checkbox"
        aria-label={t('settings.enableRule', { name: rule.label })}
        checked={rule.enabled}
        onChange={(event) => onToggle(rule.id, event.target.checked)}
      />
      <button
        type="button"
        data-rule-choice={rule.id}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(rule.id)}
        className="min-w-0 flex-1 py-2 text-left"
      >
        <span className="block truncate text-sm font-semibold text-ink">{rule.label}</span>
        <span className="text-[11px] text-ink-2">
          {rule.kind === 'local' ? t('settings.kindOnPageCheck') : t('settings.kindJevQuestion')} ·{' '}
          {rule.source === 'builtin' ? t('settings.sourceBuiltIn') : t('settings.sourceCustom')}
        </span>
      </button>
    </div>
  );
}

function SectionHeader({
  section,
  title,
  open,
  onToggleOpen,
  onSetAll,
}: {
  section: RuleSection;
  title: string;
  open: boolean;
  onToggleOpen: () => void;
  onSetAll: (enabled: boolean) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex items-center gap-1 px-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t(open ? 'settings.collapseGroup' : 'settings.expandGroup', { name: title })}
        onClick={onToggleOpen}
        className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <span aria-hidden="true" className={`flex-none text-[10px] text-ink-2 transition ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
        <span className="min-w-0 truncate text-[12px] font-bold text-ink">{title}</span>
        <span className="flex-none text-[11px] font-normal text-ink-2" data-anyfilter-group-count={section.key}>
          {t('settings.groupEnabledCount', { enabled: section.enabled, total: section.total })}
        </span>
      </button>
      {section.total > 0 && (
        <details className="relative flex-none">
          <summary
            aria-label={t('settings.groupActions', { name: title })}
            className="grid h-9 w-9 cursor-pointer list-none place-items-center rounded-lg text-ink-2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&::-webkit-details-marker]:hidden"
          >
            <span aria-hidden="true">⋯</span>
          </summary>
          <div className="absolute right-0 z-10 mt-1 flex w-36 flex-col gap-0.5 rounded-lg border border-line bg-white p-1 shadow-md">
            <button
              type="button"
              className="rounded-md px-2 py-1.5 text-left text-xs font-semibold hover:bg-surface disabled:opacity-40"
              disabled={section.enabled === section.total}
              onClick={(event) => {
                onSetAll(true);
                event.currentTarget.closest('details')?.removeAttribute('open');
              }}
            >
              {t('settings.enableAllInGroup')}
            </button>
            <button
              type="button"
              className="rounded-md px-2 py-1.5 text-left text-xs font-semibold hover:bg-surface disabled:opacity-40"
              disabled={section.enabled === 0}
              onClick={(event) => {
                onSetAll(false);
                event.currentTarget.closest('details')?.removeAttribute('open');
              }}
            >
              {t('settings.disableAllInGroup')}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}

/** The rule list: search, source and category filters, a sort, and the rules
 * grouped under their category. A category can be folded away, and its menu
 * turns every rule in it on or off at once. */
export function RuleList({
  rules,
  groups,
  query,
  onQuery,
  selectedId,
  onSelect,
  onToggle,
  onSetGroupEnabled,
}: {
  rules: readonly Rule[];
  groups: readonly RuleGroup[];
  query: ListQuery;
  onQuery: (patch: Partial<ListQuery>) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  /** `key` is a category id or {@link UNCATEGORISED}. */
  onSetGroupEnabled: (key: string, enabled: boolean) => void;
}) {
  const { t } = useLanguage();
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const list = useMemo(() => buildRuleList(rules, groups, query), [rules, groups, query]);
  const shownCount = list.sections.reduce((sum, section) => sum + section.rules.length, 0);

  const toggleFold = (key: string): void =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const titleOf = (section: RuleSection): string =>
    section.group === null ? uncategorisedLabel(t) : groupLabel(section.group, t);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="space-y-2 border-b border-line p-3">
        <input
          type="search"
          aria-label={t('settings.searchRules')}
          placeholder={t('settings.searchRulesPlaceholder')}
          className="w-full rounded-lg border border-line px-3 py-2"
          value={query.search}
          onChange={(event) => onQuery({ search: event.target.value })}
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('settings.filterRules')}>
          {(['all', 'builtin', 'custom'] as const satisfies readonly SourceFilter[]).map((source) => (
            <button
              type="button"
              key={source}
              aria-pressed={query.source === source}
              onClick={() => onQuery({ source })}
              className={`min-h-8 rounded-lg px-2.5 py-1 text-xs font-bold ${query.source === source ? 'bg-ink text-white' : 'bg-surface text-ink-2'}`}
            >
              {source === 'all'
                ? t('settings.sourceAll')
                : source === 'builtin'
                  ? t('settings.sourceBuiltIn')
                  : t('settings.sourceCustom')}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <select
            className={SELECT_CLASS}
            aria-label={t('settings.categoryFilter')}
            value={query.group}
            onChange={(event) => onQuery({ group: event.target.value })}
          >
            <option value={ANY_GROUP}>{t('settings.allCategories')}</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {groupLabel(group, t)}
              </option>
            ))}
            <option value={UNCATEGORISED}>{uncategorisedLabel(t)}</option>
          </select>
          <select
            className={SELECT_CLASS}
            aria-label={t('settings.sortRules')}
            value={query.sort}
            onChange={(event) => onQuery({ sort: event.target.value as SortMode })}
          >
            <option value="group">{t('settings.sortByCategory')}</option>
            <option value="name">{t('settings.sortByName')}</option>
            <option value="enabled">{t('settings.sortByEnabled')}</option>
          </select>
        </div>
      </div>
      <div
        className="max-h-[50vh] space-y-1 overflow-y-auto overscroll-contain p-2 @[700px]:max-h-[70vh]"
        aria-label={t('settings.rules')}
        role="group"
      >
        {list.sections.map((section) => {
          const key = section.key;
          const open = key === null || !folded.has(key);
          const rulesHere = (
            <div role="list" aria-label={key === null ? t('settings.rules') : titleOf(section)} className="space-y-0.5">
              {section.rules.map((rule) => (
                <RuleItem
                  key={rule.id}
                  rule={rule}
                  selected={selectedId === rule.id}
                  onSelect={onSelect}
                  onToggle={onToggle}
                />
              ))}
            </div>
          );
          if (key === null) return <div key="flat">{rulesHere}</div>;
          return (
            <section key={key === UNCATEGORISED ? 'uncategorised' : key} data-anyfilter-section-group={key}>
              <SectionHeader
                section={section}
                title={titleOf(section)}
                open={open}
                onToggleOpen={() => toggleFold(key)}
                onSetAll={(enabled) => onSetGroupEnabled(key, enabled)}
              />
              {open &&
                (section.rules.length > 0 ? (
                  rulesHere
                ) : (
                  <p className="m-0 px-3 py-1.5 text-[11px] text-ink-2">{t('settings.groupEmpty')}</p>
                ))}
            </section>
          );
        })}
        {shownCount === 0 && <p className="px-2 text-xs text-ink-2">{t('settings.noRulesMatch')}</p>}
      </div>
    </div>
  );
}
