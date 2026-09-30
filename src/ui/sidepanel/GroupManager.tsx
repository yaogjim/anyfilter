import { useEffect, useRef, useState } from 'react';
import type { Rule } from '../../domain/rule';
import { MAX_GROUP_NAME_LENGTH, MAX_GROUPS, type RuleGroup } from '../../domain/rule-group';
import { useLanguage, type Translate } from '../language';
import { groupLabel } from './group-label';
import { canResetName, checkGroupName, type GroupNameProblem } from './groups-draft';

const INPUT_CLASS = 'min-h-9 w-full rounded-lg border border-[#cfd9de] bg-white px-2 py-1 text-[13px]';
const ICON_BUTTON_CLASS =
  'grid h-9 w-9 flex-none place-items-center rounded-lg border border-line bg-white text-ink-2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40';
const TEXT_BUTTON_CLASS =
  'min-h-9 rounded-lg border border-[#cfd9de] bg-white px-2.5 py-1 text-xs font-bold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40';

export function problemText(problem: GroupNameProblem, t: Translate): string {
  switch (problem) {
    case 'empty':
      return t('settings.categoryNameEmpty');
    case 'too-long':
      return t('settings.categoryNameTooLong', { max: MAX_GROUP_NAME_LENGTH });
    case 'taken':
      return t('settings.categoryNameTaken');
    case 'limit':
      return t('settings.categoryLimit', { max: MAX_GROUPS });
  }
}

/** One category's row: a name that can be edited, order buttons and delete. The
 * name is only committed when it is usable, so the draft never holds a name the
 * save would refuse. Up and down are buttons rather than a drag, so the order is
 * reachable from the keyboard. */
function GroupRow({
  group,
  groups,
  count,
  index,
  onRename,
  onDelete,
  onMove,
}: {
  group: RuleGroup;
  groups: readonly RuleGroup[];
  count: number;
  index: number;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
}) {
  const { t } = useLanguage();
  const label = groupLabel(group, t);
  const [value, setValue] = useState(label);
  const [problem, setProblem] = useState<GroupNameProblem | null>(null);

  // Follow the shown name when it changes from outside (language, reset, reload).
  useEffect(() => {
    setValue(label);
    setProblem(null);
  }, [label]);

  const commit = (): void => {
    const next = value.trim();
    if (next === label) {
      setProblem(null);
      return;
    }
    const found = checkGroupName(next, groups, (g) => groupLabel(g, t), group.id);
    if (found !== null) {
      setProblem(found);
      return;
    }
    setProblem(null);
    onRename(group.id, next);
  };

  const describedBy = problem === null ? undefined : `group-problem-${group.id}`;
  return (
    <li className="flex flex-col gap-1" data-anyfilter-group={group.id}>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          className={INPUT_CLASS}
          value={value}
          maxLength={MAX_GROUP_NAME_LENGTH}
          aria-label={t('settings.categoryNameAria', { name: label })}
          aria-invalid={problem !== null}
          aria-describedby={describedBy}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') {
              event.stopPropagation();
              setValue(label);
              setProblem(null);
            }
          }}
        />
        <span className="flex-none text-[11px] text-ink-2">{t('settings.categoryRuleCount', { count })}</span>
        <button
          type="button"
          className={ICON_BUTTON_CLASS}
          aria-label={t('settings.moveCategoryUp', { name: label })}
          disabled={index === 0}
          onClick={() => onMove(group.id, -1)}
        >
          ↑
        </button>
        <button
          type="button"
          className={ICON_BUTTON_CLASS}
          aria-label={t('settings.moveCategoryDown', { name: label })}
          disabled={index === groups.length - 1}
          onClick={() => onMove(group.id, 1)}
        >
          ↓
        </button>
        <button
          type="button"
          className={`${ICON_BUTTON_CLASS} hover:text-hide`}
          aria-label={t('settings.deleteCategory', { name: label })}
          title={t('settings.deleteCategoryNote')}
          onClick={() => onDelete(group.id)}
        >
          ✕
        </button>
      </div>
      {canResetName(group) && (
        <button
          type="button"
          className="self-start text-[11px] font-bold text-ink-2 underline"
          onClick={() => onRename(group.id, '')}
        >
          {t('settings.resetCategoryName')}
        </button>
      )}
      {problem !== null && (
        <p id={describedBy} role="alert" className="m-0 text-[11px] text-hide">
          {problemText(problem, t)}
        </p>
      )}
    </li>
  );
}

/** The category editor: add, rename, reorder and delete. It edits the draft the
 * rule manager holds, nothing is stored until the rules are saved, and deleting
 * a category sends its rules back to "uncategorised" in the same draft. */
export function GroupManager({
  groups,
  rules,
  onAdd,
  onRename,
  onDelete,
  onMove,
  onClose,
}: {
  groups: readonly RuleGroup[];
  rules: readonly Rule[];
  onAdd: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<GroupNameProblem | null>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  const add = (): void => {
    const found = checkGroupName(name, groups, (g) => groupLabel(g, t));
    if (found !== null) {
      setProblem(found);
      return;
    }
    setProblem(null);
    onAdd(name.trim());
    setName('');
  };

  return (
    <section
      ref={panel}
      tabIndex={-1}
      role="group"
      aria-label={t('settings.categoriesTitle')}
      data-anyfilter-groups="manager"
      className="rounded-xl border border-line bg-surface p-3 focus:outline-none"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="m-0 text-[13px] font-bold text-ink">{t('settings.categoriesTitle')}</h4>
          <p className="mb-2 mt-0.5 text-[11px] text-ink-2">{t('settings.categoriesIntro')}</p>
        </div>
        <button type="button" className={TEXT_BUTTON_CLASS} onClick={onClose}>
          {t('settings.categoriesDone')}
        </button>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {groups.map((group, index) => (
          <GroupRow
            key={group.id}
            group={group}
            groups={groups}
            index={index}
            count={rules.filter((rule) => rule.group === group.id).length}
            onRename={onRename}
            onDelete={onDelete}
            onMove={onMove}
          />
        ))}
      </ul>
      <form
        className="mt-2 flex flex-wrap items-start gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <div className="min-w-0 flex-1">
          <input
            type="text"
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
          />
          {problem !== null && (
            <p role="alert" className="m-0 mt-1 text-[11px] text-hide">
              {problemText(problem, t)}
            </p>
          )}
        </div>
        <button type="submit" className={TEXT_BUTTON_CLASS} disabled={groups.length >= MAX_GROUPS}>
          {t('settings.addCategory')}
        </button>
      </form>
    </section>
  );
}
