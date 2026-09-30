import { useState } from 'react';
import { groupByReason, hiddenOfKind, type PanelState, type ReasonGroup } from '../../domain/panel-state';
import type { PostKind } from '../../domain/post';
import type { Rule } from '../../domain/rule';
import type { RuleGroup } from '../../domain/rule-group';
import { useLanguage } from '../language';
import { groupLabel, uncategorisedLabel } from './group-label';
import { groupByCategory, makeCategoryResolver, type GroupBy } from './hidden-groups-model';
import { ReasonAccordion } from './ReasonAccordion';
import { panelId, tabId, TabStrip, type TabItem } from './TabStrip';

const ID_BASE = 'anyfilter-hidden';

function GroupByToggle({ value, onChange }: { value: GroupBy; onChange: (value: GroupBy) => void }) {
  const { t } = useLanguage();
  const options: ReadonlyArray<{ id: GroupBy; label: string }> = [
    { id: 'rule', label: t('shell.hidden.byRule') },
    { id: 'category', label: t('shell.hidden.byCategory') },
  ];
  return (
    <div role="group" aria-label={t('shell.hidden.groupBy')} className="flex items-center gap-1.5 text-[11px] text-ink-2">
      <span>{t('shell.hidden.groupBy')}</span>
      <span className="flex rounded-md bg-surface p-0.5">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={value === option.id}
            data-anyfilter-groupby={option.id}
            onClick={() => onChange(option.id)}
            className={`min-h-7 rounded px-2 text-[11px] font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
              value === option.id ? 'bg-white text-ink shadow-sm' : 'hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/** What the filter has hidden, one kind at a time: posts and replies are two tabs
 * with their counts, and the list under the tab is grouped by rule or by the
 * rule's category. Posts open by default. */
export function HiddenGroups({
  state,
  labelOrder,
  rules,
  groups,
  onOverride,
}: {
  state: PanelState;
  labelOrder: readonly string[];
  rules: readonly Rule[];
  groups: readonly RuleGroup[];
  onOverride: (postId: string, shown: boolean) => Promise<void>;
}) {
  const { t } = useLanguage();
  const [kind, setKind] = useState<PostKind>('post');
  const [groupBy, setGroupBy] = useState<GroupBy>('rule');

  const posts = hiddenOfKind(state, 'post');
  const replies = hiddenOfKind(state, 'reply');
  const entries = kind === 'post' ? posts : replies;

  let grouped: ReasonGroup[];
  if (groupBy === 'rule') {
    grouped = groupByReason(entries, labelOrder);
  } else {
    const resolve = makeCategoryResolver(rules, groups, {
      groupLabel: (group) => groupLabel(group, t),
      uncategorised: uncategorisedLabel(t),
    });
    grouped = groupByCategory(entries, resolve);
  }

  if (posts.length === 0 && replies.length === 0) {
    return (
      <section className="rounded-xl border border-line bg-white p-3.5" data-anyfilter-section="post">
        <h2 className="m-0 text-[15px] font-bold text-ink">{t('shell.hidden.postsTitle')}</h2>
        <p className="m-0 py-1.5 text-ink-2">{t('shell.hidden.nothingYet')}</p>
      </section>
    );
  }

  const items: TabItem[] = [
    { id: 'post', label: t('shell.hidden.tabPosts', { count: posts.length }) },
    { id: 'reply', label: t('shell.hidden.tabReplies', { count: replies.length }) },
  ];

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-white p-3.5">
      <TabStrip
        idBase={ID_BASE}
        items={items}
        selected={kind}
        onSelect={(id) => setKind(id === 'reply' ? 'reply' : 'post')}
        label={t('shell.hidden.tabs')}
      />
      {entries.length > 0 && <GroupByToggle value={groupBy} onChange={setGroupBy} />}
      <section role="tabpanel" id={panelId(ID_BASE)} aria-labelledby={tabId(ID_BASE, kind)} data-anyfilter-section={kind}>
        {grouped.length === 0 ? (
          <p className="m-0 py-1.5 text-ink-2">{t('shell.hidden.noneYet')}</p>
        ) : (
          grouped.map((group) => (
            <ReasonAccordion key={`${groupBy}:${group.label}`} group={group} kind={kind} onOverride={onOverride} />
          ))
        )}
      </section>
    </div>
  );
}
