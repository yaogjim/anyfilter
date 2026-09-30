/**
 * English strings for the "Other sites" card. Keys are stable identifiers; the
 * matching `sites.zh-CN.ts` must export exactly the same set.
 */
export const sitesEn = {
  'sites.heading': 'Other sites',
  'sites.intro':
    'X works out of the box. A site listed here stays untouched until you turn it on; your browser then asks you to allow it.',
  'sites.hn.blurb':
    'On list pages (front page, newest, ask, show…), hides titles that match your politics, crypto, NSFW and platitude rules, and your own rules. Only the title and the site it links to are sent. Comments are not read.',
  'sites.turnOn': 'Turn on',
  'sites.turnOff': 'Turn off',
  'sites.on': 'On',
  'sites.off': 'Off',
  'sites.denied': 'Your browser did not allow access to {site}, so it stays off.',
  'sites.note': 'Open pages pick a new setting up right away, except turning off, which takes effect when the page is reloaded.',
  'shell.hidden.openOnHn': 'Open on Hacker News ↗',
} as const;
