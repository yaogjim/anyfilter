/**
 * English UI strings for the side-panel and options-page shells (translate-key
 * resource).
 *
 * Keys are stable identifiers only: components never pass English/Chinese pairs
 * to `t(...)`. The matching `shell.zh-CN.ts` exports exactly the same key set,
 * so a key can never exist in one language only.
 *
 * Dynamic values are written as `{name}` placeholders and substituted by the
 * shared `Translate` implementation. A placeholder only ever carries a technical
 * or user-authored value that must not be translated: a count, a provider error
 * detail, or another already-localized fragment. Rule names, post text and
 * backend error details are never stored here.
 */
export const shellEn = {
  'shell.loading': 'Loading…',
  'shell.overview': 'Overview',
  'shell.settingsHeading': 'Settings',
  'shell.openFullPage': 'Open full page',

  // Header status line. `{count}` is the number of scanned posts; `{detail}` is
  // an untranslated provider error detail.
  'shell.status.filterOff': 'Filter off · showing all {count} posts',
  'shell.status.addApiKey': 'Add your API key in Settings to filter by intent',
  'shell.status.failureRateLimited':
    'Provider is rate-limiting this key — retrying automatically',
  'shell.status.failureAuth':
    'Provider rejected the API key (401/403) — check it in Settings',
  'shell.status.failureNetwork': 'Could not reach the provider: {detail}',
  'shell.status.failureBadResponse': 'Unexpected provider response: {detail}',

  // Header navigation and toggle.
  'shell.nav.home': 'Home',
  'shell.nav.views': 'Views',
  'shell.nav.settings': 'Settings',
  'shell.nav.verification': 'Verify',
  'shell.filterOn': 'Filter on',

  // Hidden-post sections.
  'shell.hidden.postsTitle': 'Posts hidden',
  'shell.hidden.tabs': 'Hidden items',
  'shell.hidden.tabPosts': 'Posts {count}',
  'shell.hidden.tabReplies': 'Replies {count}',
  'shell.hidden.groupBy': 'Group by',
  'shell.hidden.byRule': 'Rule',
  'shell.hidden.byCategory': 'Category',
  'shell.hidden.noneYet': 'None yet.',
  'shell.hidden.nothingYet':
    'Nothing hidden yet. Scroll your timeline to start.',
  'shell.hidden.adBadge': 'ad',
  'shell.hidden.hideAgain': 'Hide again',
  'shell.hidden.putBack': 'Put back in feed',
  'shell.hidden.openOnX': 'Open on X ↗',

  // Home banner shown when filtering cannot work until something is configured.
  'shell.banner.configure': 'Configure',

  // Overview tiles.
  'shell.tiles.hidden': 'Hidden posts',
  'shell.tiles.kept': 'Kept posts',
  'shell.tiles.scanned': 'Posts scanned',
  'shell.tiles.timeSaved': 'Time saved',
  'shell.tiles.spent': 'Spent on Jev',
  'shell.tiles.tokens': 'Tokens used',
  'shell.tiles.more': 'Other figures',

  // Reason accordion.
  'shell.reason.inConversation': 'In a conversation',
  'shell.reason.repliesUnder': 'Replies under',

  // Post card.
  'shell.post.showMore': 'Show more',
  'shell.post.video': 'Video',

  // Options page shell and section navigation.
  'shell.options.title': 'AnyFilter settings',
  'shell.options.subtitle':
    'Filtering on X. Provider and threshold save as you edit; rules save when applied.',
  'shell.options.sections': 'Settings sections',
  'shell.options.onThisPage': 'On this page',
  'shell.nav.appearance': 'Appearance',
  'shell.nav.models': 'Models & keys',
  'shell.nav.behavior': 'Filtering',
  'shell.nav.rules': 'Rules',
  'shell.nav.capture': 'Verification samples',
  'shell.nav.data': 'Data',
} as const;