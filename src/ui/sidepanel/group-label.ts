import type { RuleGroup } from '../../domain/rule-group';
import type { Translate, TranslationKey } from '../language';

/** Display names of the default categories, in the interface language. A default
 * category only carries its own name once the person renames it. */
const DEFAULT_NAME_KEY: Readonly<Record<string, TranslationKey>> = {
  marketing: 'settings.group.marketing',
  engagement: 'settings.group.engagement',
  harmful: 'settings.group.harmful',
  politics: 'settings.group.politics',
};

export function groupLabel(group: RuleGroup, t: Translate): string {
  if (group.name !== '') return group.name;
  const key = DEFAULT_NAME_KEY[group.id];
  return key === undefined ? group.id : t(key);
}

export function uncategorisedLabel(t: Translate): string {
  return t('settings.group.ungrouped');
}
