/**
 * English strings for the "This page" view. Keys are stable identifiers; the
 * matching `page.zh-CN.ts` must export exactly the same set.
 *
 * Wording rule from docs/article-rules.md: the page "reads like" something and a
 * probability is shown. It is never stated as a fact about the page or its author.
 */
export const pageEn = {
  'page.nav': 'This page',
  'page.heading': 'This page',
  'page.intro':
    'Reads the page in the tab you opened AnyFilter on, when you press the button, and sends its first {count} words to your provider once. Nothing is judged in the background unless you turn on auto judging below.',
  'page.judge': 'Judge this page',
  'page.judging': 'Judging…',
  'page.judgedPage': '{title} · {units} words',
  'page.untitled': 'Untitled page',
  'page.truncatedNote': 'Only the first {count} words were judged.',

  'page.notArticle.title': 'Not judged as an article',
  'page.notArticle.blocked': 'This looks like a bot-check or error page.',
  'page.notArticle.tooShort': 'This page has too little text to judge as an article.',
  'page.notArticle.rootPage': 'This is a site home page, not a single article.',
  'page.notArticle.loginPage': 'This is a sign-in page, not an article.',
  'page.notArticle.xPage':
    'This is an X page. The feed filter reads X post by post; it is not judged as an article.',
  'page.notArticle.model':
    'The model thinks this is not one article (a list, feed or index), so no rule was applied.',

  'page.rule.marketing': 'marketing',
  'page.rule.clickbait': 'clickbait',

  'page.match': 'Reads like {label} · {probability}% (threshold {threshold}%)',
  'page.clean': 'No rule matched.',
  'page.othersMatched': 'Also matched: {labels}',
  'page.undetermined': '{label}: not decided — {reason}',
  'page.reason.truncated': 'only the beginning of the page was read',
  'page.reason.paywall': 'this looks like a paywall preview',
  'page.reason.noAnswer': 'the model gave no answer',
  'page.details': 'Every rule',
  'page.detail.scored': '{label}: {probability}% · threshold {threshold}%',
  'page.detail.unscored': '{label}: no answer',
  'page.disclaimer':
    'A probability from a model that only reads the text. It says how the text reads, not who wrote it or why.',

  'page.hint.needsIcon':
    'To read this tab, click the AnyFilter icon in the toolbar while it is showing. Browser pages such as chrome:// cannot be read at all.',
  'page.hint.unreadable': 'This kind of page cannot be read.',
  'page.hint.xPage': 'This is an X page. The feed filter handles X; there is nothing to judge here.',
  'page.error.noAccess':
    'This tab cannot be read. Click the AnyFilter icon in the toolbar while this tab is showing, then judge again. Browser pages such as chrome:// cannot be read at all.',
  'page.error.extractFailed': 'Nothing readable came out of this page.',
  'page.error.noKey': 'Add your API key in Settings to judge a page.',
  'page.error.rateLimited': 'The provider is rate-limiting this key. Try again in a moment.',
  'page.error.auth': 'The provider rejected the API key (401/403). Check it in Settings.',
  'page.error.network': 'Could not reach the provider: {detail}',
  'page.error.badResponse': 'Unexpected provider response: {detail}',
  'auto.heading': 'Auto judging',
  'auto.intro':
    'When on, a page is read and judged as soon as it finishes loading, but only on sites you allow below and only in the tab in front. The same words go to your provider as when you press the button. Off by default.',
  'auto.on': 'On',
  'auto.off': 'Off',
  'auto.turnOn': 'Turn on',
  'auto.turnOff': 'Turn off',
  'auto.site.heading': 'Sites',
  'auto.site.none': 'No site is allowed yet. Auto judging does nothing until you allow one.',
  'auto.site.allowThis': 'Allow {host}',
  'auto.site.allowed': '{host} is allowed',
  'auto.site.revoke': 'Remove',
  'auto.site.revokeLabel': 'Stop auto judging on {host}',
  'auto.site.denied': 'The browser did not grant access to {host}.',
  'auto.site.notOffered': 'Auto judging is not offered on this kind of page.',
  'auto.site.needsIcon': 'Click the AnyFilter icon on this tab to see which site it is.',
  'auto.usage': 'Spent {spent} of {cap} · {count} of {limit} requests today',
  'auto.badgeNote': 'A matching page shows MKT (marketing) or BAIT (clickbait) on the toolbar icon. Pages with nothing to report show nothing.',
  'auto.paused': 'Stopped after {count} failed requests in a row. Fix the cause (usually the key in Settings), then resume.',
  'auto.resume': 'Resume',
  'auto.capReached': 'The cap is reached. Auto judging is not sending anything. Pressing “Judge this page” still works.',
  'auto.dailyReached': 'Today’s request limit is reached. Auto judging continues tomorrow.',
  'auto.resetSpend': 'Reset usage',
  'page.autoResult': 'Judged automatically when the page loaded.',
} as const;
