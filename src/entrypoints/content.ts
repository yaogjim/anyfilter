import { isRuntimeMessage } from '../domain/messages';
import { FeedFilter } from '../features/feed-filter';
import { BackgroundClient } from '../infrastructure/background-client';
import { loadSettings, onSettingsChanged } from '../infrastructure/settings-store';
import { TimelineView } from '../infrastructure/timeline-view';

export default defineContentScript({
  matches: ['https://x.com/*'],

  async main(ctx) {
    const client = new BackgroundClient();
    const filter = new FeedFilter(new TimelineView(), client, client, await loadSettings());
    await filter.hydrate();
    const unsubscribe = onSettingsChanged((settings) => filter.applySettings(settings));
    const onMessage = (message: unknown): void => {
      if (!isRuntimeMessage(message)) return;
      if (message.type === 'override') filter.override(message.postId, message.shown);
      else if (message.type === 'clear-data') filter.clear();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    filter.start();
    ctx.onInvalidated(() => {
      filter.stop();
      unsubscribe();
      chrome.runtime.onMessage.removeListener(onMessage);
    });
  },
});
