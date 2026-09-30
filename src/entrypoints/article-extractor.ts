import { extractArticle } from '../infrastructure/article-extract';

/**
 * Injected on demand by the background with `chrome.scripting.executeScript`,
 * after the person clicked the toolbar icon on a tab. It is not a manifest
 * content script and carries no `matches`, so it adds no site permission: on a
 * page the extension was not opened on, injection is refused by the browser.
 * The value returned from `main` is what `executeScript` hands back.
 */
export default defineUnlistedScript({
  globalName: true,
  main() {
    return extractArticle(document, location.href);
  },
});
