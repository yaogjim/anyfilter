import { isRuntimeMessage } from '../domain/messages';
import { PassiveCapture, PassiveOutcomeReporter } from '../features/evaluation-capture';
import { FeedFilter } from '../features/feed-filter';
import { ReviewAnnotations } from '../features/review-annotations';
import { BackgroundClient } from '../infrastructure/background-client';
import { loadCaptureState, onCaptureStateChanged } from '../infrastructure/capture-store';
import { ReviewToolbar } from '../infrastructure/review-toolbar';
import { loadSettings, onSettingsChanged, saveReviewMode } from '../infrastructure/settings-store';
import { TimelineView } from '../infrastructure/timeline-view';
import { loadUiLocale, onUiLocaleChanged } from '../infrastructure/ui-locale';

export default defineContentScript({
  matches: ['https://x.com/*'],

  async main(ctx) {
    const client = new BackgroundClient();
    // The reporter is wired into the filter, but stays inert until capture is
    // actually active: its `captureEpoch()` is `0` while the run state is `off`,
    // so the feed records nothing and filters exactly as before.
    const outcomeReporter = new PassiveOutcomeReporter((epoch, outcomes) =>
      client.recordOutcomes(epoch, outcomes),
    );
    const view = new TimelineView();
    let settings = await loadSettings();
    const filter = new FeedFilter(view, client, client, settings, outcomeReporter);
    await filter.hydrate();

    // Review mode follows one stored setting for every X page, so a new page or a
    // reload opens in the same state instead of starting over.
    view.review.setLocale(await loadUiLocale());
    // Annotations are stored by the background; the page only asks for them. A
    // label is drawn only after the background confirmed it.
    const annotations = new ReviewAnnotations(
      {
        load: () => client.loadReviewRecords(),
        save: (epoch, input) => client.saveReview(epoch, input),
        remove: (epoch, key) => client.removeReview(epoch, key),
      },
      () => view.review.refresh(),
    );
    view.review.setAnnotations(annotations);
    void annotations.load();
    // "Exit" on the bar turns review mode off everywhere, like the switch in
    // settings does.
    const toolbar = new ReviewToolbar(view.review, {
      onExit: () => {
        setReview(false);
        void saveReviewMode(false);
      },
    });
    const setReview = (on: boolean): void => {
      if (on) {
        filter.setReviewMode(true);
        toolbar.mount();
        toolbar.update({ filterOn: settings.filterOn });
      } else {
        // The bar goes first so its filter and pause are undone before the
        // decorations are removed.
        toolbar.unmount();
        filter.setReviewMode(false);
      }
    };
    const unsubscribe = onSettingsChanged((next) => {
      settings = next;
      filter.applySettings(next);
      if (next.reviewMode !== filter.isReviewMode()) setReview(next.reviewMode);
      else if (filter.isReviewMode()) toolbar.update({ filterOn: next.filterOn });
    });
    const unsubscribeLocale = onUiLocaleChanged((locale) => {
      view.review.setLocale(locale);
      toolbar.render();
    });

    // Passive capture runs next to the filter and never replaces it: it reads the
    // page and hands posts to the background, and it cannot hide, un-hide or
    // re-flag anything. Turning it on never turns filtering off, and turning it
    // off never changes what the feed hides.
    const capture = new PassiveCapture((epoch, posts) => client.submitCapture(epoch, posts));
    const initialCapture = await loadCaptureState();
    capture.applyState(initialCapture);
    outcomeReporter.applyState(initialCapture);
    const unsubscribeCapture = onCaptureStateChanged((state) => {
      capture.applyState(state);
      outcomeReporter.applyState(state);
    });

    const onMessage = (message: unknown, sender: chrome.runtime.MessageSender): void => {
      if (!isRuntimeMessage(message)) return;
      if (message.type === 'override') filter.override(message.postId, message.shown);
      else if (message.type === 'clear-data') {
        filter.clear();
        void annotations.load();
      } else if (message.type === 'review-reload') {
        if (sender.id === chrome.runtime.id) void annotations.load();
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    filter.start();
    if (settings.reviewMode) setReview(true);
    ctx.onInvalidated(() => {
      filter.stop();
      toolbar.unmount();
      view.review.clearAll();
      unsubscribeLocale();
      capture.stop();
      outcomeReporter.stop();
      unsubscribeCapture();
      unsubscribe();
      chrome.runtime.onMessage.removeListener(onMessage);
    });
  },
});