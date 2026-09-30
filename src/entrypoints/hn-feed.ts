import { ContentScriptContext } from 'wxt/utils/content-script-context';
import { hnSettings } from '../domain/hn';
import { isRuntimeMessage } from '../domain/messages';
import { FeedFilter } from '../features/feed-filter';
import { BackgroundClient } from '../infrastructure/background-client';
import { HnReviewBar } from '../infrastructure/hn-review';
import { HnView } from '../infrastructure/hn-view';
import { loadSettings, onSettingsChanged, saveReviewMode } from '../infrastructure/settings-store';
import { loadUiLocale, onUiLocaleChanged } from '../infrastructure/ui-locale';

/**
 * The Hacker News content script. It is not in the manifest: the background
 * registers it only after the person turned Hacker News on in the panel and the
 * browser granted the site, so a fresh install has no access to it.
 *
 * It is the X feed's filter pointed at another page: the same `FeedFilter`, the
 * same settings and the same panel list, with the person's rules narrowed to the
 * ones that mean something for a headline (`domain/hn.ts`). Review mode is shared:
 * the same stored switch keeps every row visible and draws what AnyFilter would do.
 * There is no labelling, capture or evaluation here; those are X's.
 */
export default defineUnlistedScript({
  async main() {
    // A second copy of this script (the registered one and the one injected into an
    // already-open tab) invalidates the first, so only one is ever filtering.
    const ctx = new ContentScriptContext('hn-feed');
    const client = new BackgroundClient();
    const view = new HnView();
    let settings = await loadSettings();
    const filter = new FeedFilter(view, client, client, hnSettings(settings));
    await filter.hydrate();

    view.review.setLocale(await loadUiLocale());
    const bar = new HnReviewBar(view.review, () => {
      setReview(false);
      void saveReviewMode(false);
    });
    const setReview = (on: boolean): void => {
      if (on) {
        filter.setReviewMode(true);
        bar.mount();
        bar.update({ filterOn: settings.filterOn });
      } else {
        bar.unmount();
        filter.setReviewMode(false);
      }
    };
    const unsubscribe = onSettingsChanged((next) => {
      settings = next;
      filter.applySettings(hnSettings(next));
      if (next.reviewMode !== filter.isReviewMode()) setReview(next.reviewMode);
      else if (filter.isReviewMode()) bar.update({ filterOn: next.filterOn });
    });
    const unsubscribeLocale = onUiLocaleChanged((locale) => {
      view.review.setLocale(locale);
      bar.render();
    });

    const onMessage = (message: unknown): void => {
      if (!isRuntimeMessage(message)) return;
      if (message.type === 'override') filter.override(message.postId, message.shown);
      else if (message.type === 'clear-data') filter.clear();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    filter.start();
    if (settings.reviewMode) setReview(true);

    ctx.onInvalidated(() => {
      filter.stop();
      bar.unmount();
      view.review.clearAll();
      unsubscribeLocale();
      unsubscribe();
      chrome.runtime.onMessage.removeListener(onMessage);
    });
  },
});
