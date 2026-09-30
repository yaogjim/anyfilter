import { useRef, type KeyboardEvent } from 'react';
import { useLanguage } from '../language';

export interface TabItem {
  id: string;
  label: string;
  /** The one in use: shown with a dot. */
  inUse?: boolean;
  /** A key is stored for it: shown with a check mark. */
  keySet?: boolean;
}

export function tabId(idBase: string, id: string): string {
  return `${idBase}-tab-${id}`;
}

export function panelId(idBase: string): string {
  return `${idBase}-panel`;
}

/** A row of tabs with roving focus and arrow-key movement. Selecting a tab only
 * chooses what to look at; "in use" is a separate mark the parent decides, so a
 * glance at another tab never changes what the extension uses. The parent
 * renders the matching `role="tabpanel"` using {@link panelId} and {@link tabId}. */
export function TabStrip({
  idBase,
  items,
  selected,
  onSelect,
  label,
}: {
  idBase: string;
  items: readonly TabItem[];
  selected: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  const { t } = useLanguage();
  const refs = useRef(new Map<string, HTMLButtonElement>());

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    const target = items[next];
    onSelect(target.id);
    refs.current.get(target.id)?.focus();
  };

  return (
    <div className="flex flex-wrap rounded-lg bg-surface p-0.5" role="tablist" aria-label={label}>
      {items.map((item, index) => {
        const isSelected = item.id === selected;
        return (
          <button
            key={item.id}
            ref={(node) => {
              if (node) refs.current.set(item.id, node);
              else refs.current.delete(item.id);
            }}
            id={tabId(idBase, item.id)}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls={panelId(idBase)}
            tabIndex={isSelected ? 0 : -1}
            data-anyfilter-tab={item.id}
            className={`flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
              isSelected ? 'bg-white text-ink shadow-sm' : 'text-ink-2 hover:text-ink'
            }`}
            onClick={() => onSelect(item.id)}
            onKeyDown={(event) => move(event, index)}
          >
            {item.inUse === true && (
              <span
                aria-hidden="true"
                title={t('settings.tabInUse')}
                className="h-1.5 w-1.5 flex-none rounded-full bg-keep"
              />
            )}
            <span className="min-w-0 truncate">{item.label}</span>
            {item.keySet === true && (
              <span aria-hidden="true" title={t('settings.tabKeySet')} className="flex-none text-keep">
                ✓
              </span>
            )}
            <span className="sr-only">
              {[item.inUse === true ? t('settings.tabInUse') : '', item.keySet === true ? t('settings.tabKeySet') : '']
                .filter((part) => part !== '')
                .join(', ')}
            </span>
          </button>
        );
      })}
    </div>
  );
}
