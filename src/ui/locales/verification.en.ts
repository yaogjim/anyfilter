/**
 * English UI resources for the verification and capture sections of the side
 * panel.
 *
 * This is a plain, flat key → string table: the key is the stable identifier the
 * components pass to `t(...)`, and the value is the exact English sentence. The
 * matching `verification.zh-CN.ts` file exports the very same key set, so a key
 * can never exist in one language only.
 *
 * Dynamic values are written as `{name}` placeholders and substituted by the
 * shared `Translate` implementation. A placeholder never carries a sentence
 * again: it is either a technical value that must not be translated (a model
 * name, a formatted amount, a domain reason detail, rule label, sample text) or
 * another already-localized fragment supplied by the caller.
 *
 * Wording notes that must survive any edit, in both languages: the spend cap is a
 * local estimate and not a provider-enforced hard cap; an unknown charge keeps
 * its reservation and is never refunded; a request that may already have been
 * charged is never retried on its own; and nothing is sent without an explicit
 * click and an explicit confirmation of the exact text.
 */

/**
 * Capture-name key set. Also spread into {@link verificationEn} so a single
 * import can resolve both the `verification.*` and `capture.*` keys.
 */
export const captureEn = {
  'capture.heading': 'Capture',
  'capture.loading': 'Loading…',
  'capture.status.off': 'Off — nothing is read from the page.',
  'capture.status.paused': 'Paused — {stored} sample(s) kept.',
  'capture.status.active': 'Capturing — {stored} sample(s) stored.',
  'capture.pause': 'Pause capturing',
  'capture.resume': 'Resume capturing',
  'capture.start': 'Start capturing',
  'capture.turnOff': 'Turn off',
  'capture.deleteSamples': 'Delete samples',
  'capture.privacyNote':
    'Saves already-loaded X text on this device only; capturing itself calls no model. Normal filtering may still send posts to your chosen provider; confirm each one before a verification send.',
  'capture.detailsSummary': 'Capture details',
  'capture.scopeNote':
    'Off by default. When on, it reads the public text of posts your browser has already loaded on an open X home, search or post page and keeps a local copy in this browser. Own posts are skipped when your account is identifiable; observation waits otherwise. Posts without text or matching protected placeholders are skipped, but these checks cannot establish that every saved post is public or safe to share. This capture itself makes no model request and does not change what the filter hides; normal filtering may still send posts to your selected provider. This library is not randomly sampled or human-reviewed, so it cannot establish an accuracy rate. Deleting samples only removes this library — your rules, threshold and key stay. If you have manually verified a sample, its separate task record (without post text) and spent or unresolved charges remain after this deletion.',
  'capture.retentionNote':
    'The library is capped at {max} samples; the oldest is dropped first. Samples expire after seven days and are removed when the extension background next runs. {skipped} observation(s) were read but not stored. "Clear everything" in Settings does not delete these samples; use Delete samples here.',
} as const;

export const verificationEn = {
  'verification.heading': 'Verify one sample',
  'verification.loading': 'Loading…',
  'verification.budgetNote':
    'USD 1 is a local budget based on estimated costs, not a provider-enforced spending limit. Sending a sample may charge your TypeSafe account.',
  'verification.budgetOn': 'Budget is on',
  'verification.enableBudget': 'Enable verification budget (USD 1 cap)',
  'verification.stopBudget': 'Stop verification budget',
  'verification.stopNote':
    'Stopping refuses every new request. It cannot recall one that was already sent: that request may still be charged, and its reservation stays held as unknown rather than being refunded.',

  // Budget status line (`statusLine`). `{amount}` is an already-formatted amount.
  'verification.status.disabled':
    'Verification budget off. Nothing can be sent until you switch it on below.',
  'verification.status.disabledHeld':
    ' {amount} stays held for requests that were already sent; that reservation is not refunded by stopping.',
  'verification.status.onForModel': 'Budget on for {model}',
  'verification.status.cap': 'cap {amount}',
  'verification.status.spent': 'spent {amount}',
  'verification.status.held': 'held {amount}',
  'verification.status.available': 'available {amount}',

  // One run's outcome (`resultText`). `{detail}` is an untranslated domain detail.
  'verification.result.match':
    "Match — score {score} at threshold {threshold}. That score is the model's judgement, not an accuracy rate.",
  'verification.result.noMatch':
    "No match — score {score} below threshold {threshold}. That score is the model's judgement, not an accuracy rate.",
  'verification.result.undecided':
    'Undecided — the call was charged but returned no usable answer for this rule. {detail}',
  'verification.result.unknown':
    'Unknown — the request may have been sent and no usable usage was recorded, so its reservation stays held and it is never retried on its own. {detail}',
  'verification.result.skipped': 'Not sent — {reason}. {detail}',

  // Why one send was skipped (`skipLabel`). The reason code itself is a domain value.
  'verification.skip.notAuthorized': 'not authorized',
  'verification.skip.noKey': 'no TypeSafe key is stored',
  'verification.skip.sampleNotFound': 'the sample is no longer stored',
  'verification.skip.notSendable':
    'the sample is not allowed to leave this browser',
  'verification.skip.ruleNotCompiled':
    'the rule has no applicable question for this sample',
  'verification.skip.budgetDisabled': 'the verification budget is off',
  'verification.skip.capExceeded':
    'the USD 1 cap does not cover one more request',
  'verification.skip.budgetRefused': 'the budget refused the reservation',
  'verification.skip.alreadyRecorded':
    'this exact task is already recorded; it is never sent twice',
  'verification.skip.jobInactive':
    'a stop or delete landed first, so nothing was sent',
  'verification.skip.storage': 'the request could not be completed',
  'verification.skip.wrongSender':
    'the request did not come from this extension’s own page',

  // Budget/cost/safety disclosure (`disclosureLines`). `{model}` and `{cap}` are
  // technical values and stay untranslated.
  'verification.disclosure.model':
    'Model: TypeSafe Jev 1.13 ({model}). It is pinned and verified; no other model, endpoint or key can be chosen here.',
  'verification.disclosure.cap':
    'Spending cap: {cap} for this verification budget. The published worst-case cost is held before anything is sent. This is a local estimate at the documented Jev 1.13 price, not a provider-enforced hard spending cap; provider pricing can change.',
  'verification.disclosure.charge':
    'A real request may be charged to the account behind your stored TypeSafe key and cannot be recalled or refunded.',
  'verification.disclosure.thirdParty':
    'The selected sample may contain third-party content. Confirm that this one post may be sent before you ask for a call.',
  'verification.disclosure.score':
    "A returned score is the model's judgement, not an accuracy rate.",
  'verification.disclosure.unknownUsage':
    'If a response reports no usable usage, its reservation stays held as unknown instead of being guessed.',

  // Warnings shown next to one sample's exact text (`flagText`), keyed by the
  // domain flag key. English wording mirrors the domain module verbatim.
  'verification.flag.exactState':
    'This is the exact stored state one verification would send: the author, the full body and any quoted or parent text. Nothing is re-read from the page, and nothing has been sent yet.',
  'verification.flag.truncated':
    'This body was already clipped when it was captured, so the text above may not be the whole post that was read.',
  'verification.flag.excerptMismatch':
    'The stored excerpt does not match this stored body, so the shorter preview shown before this describes different text. Treat this sample as uncertain.',
  'verification.flag.thirdParty':
    'This preview includes quoted or parent content written by other people. Read all of it before you send.',

  // Why a preview read was refused (`previewRefusalText`); the reason code is a
  // domain value. An unrecognized reason falls back to the domain message itself.
  'verification.previewRefusal.wrongSender':
    'the request did not come from this extension’s own page',
  'verification.previewRefusal.sampleNotFound': 'the sample is no longer stored',
  'verification.previewRefusal.unreadable': 'the preview could not be loaded',

  // Source labels for one row (`sourceLabel`), one per capture page.
  'verification.source.home': 'Home',
  'verification.source.search': 'Search',
  'verification.source.status': 'Post',
  'verification.sourceLabel': 'Source',
  'verification.allSources': 'All sources',

  // Short relative age (`relativeTime`).
  'verification.time.justNow': 'just now',
  'verification.time.minutesAgo': '{minutes}m ago',
  'verification.time.hoursAgo': '{hours}h ago',
  'verification.time.daysAgo': '{days}d ago',

  // Bounded, paginated sample list.
  'verification.localSamples': 'Local samples',
  'verification.noSamples':
    'No stored sample yet. Capture some under Capture. Nothing is sent automatically.',
  'verification.searchSamples': 'Search samples',
  'verification.searchPlaceholder': 'Search text or source',
  'verification.selectFree': 'Selecting a sample is free — nothing is sent.',
  'verification.badge.truncated': 'truncated',
  'verification.badge.promoted': 'promoted',
  'verification.badge.reply': 'reply',
  'verification.noMatching': 'No matching samples.',
  'verification.previous': 'Previous',
  'verification.page': 'Page {page} / {count}',
  'verification.next': 'Next',

  // Detail pane.
  'verification.backToSamples': '← Back to samples',
  'verification.selectSample':
    'Select a sample to review its exact text. Selecting is free.',
  'verification.exactTextHeading': 'Exact text that would be sent',
  'verification.previewLoading':
    'Loading the exact stored text… nothing can be sent until it is shown.',
  'verification.previewUnreadable': 'The stored text could not be read.',
  'verification.cannotSend': 'This sample cannot be sent.',
  'verification.fullSource': 'Full source',
  'verification.quotedPost': 'Quoted post',
  'verification.replyingTo': 'Replying to',

  // Rule selection.
  'verification.ruleLabel': 'Enabled semantic rule',
  'verification.chooseRule': 'Choose one rule…',
  'verification.threshold': 'threshold',
  'verification.noApplicableRule':
    'No enabled semantic rule applies to this sample. A replies-only rule needs parent context.',

  // Confirmation and the single send.
  'verification.confirm':
    'I have read the exact text above and confirm that this one post may be sent to TypeSafe. It may be charged to my account and cannot be recalled.',
  'verification.running': 'Running one verification…',
  'verification.send': 'Send this one sample for verification',
  'verification.sendNote':
    'One click sends exactly one request for this one sample and this one rule. Nothing is queued, repeated or traversed, and no request is made unless you press the button. The model, the price, the endpoint and your stored TypeSafe key are fixed here and cannot be edited. The button stays disabled until this sample’s exact text has been loaded, shown and confirmed.',
  'verification.disclosureSummary': 'Budget, cost and safety details',

  // Trace summary under a result. Model/token/amount values stay untranslated.
  'verification.trace.requested': 'requested',
  'verification.trace.answered': 'answered',
  'verification.trace.tokensIn': 'tokens in',
  'verification.trace.unknown': 'unknown',
  'verification.trace.out': 'out',
  'verification.trace.recordedCost': 'recorded cost',
  'verification.trace.truncated': 'the captured body was already truncated',

  'verification.unknownHeld':
    'The reservation for this call stays held until you reconcile it, because the request may already have been charged.',

  // Budget on/stop confirmations. A refusal instead shows the domain detail unchanged.
  'verification.message.enabled':
    'Verification budget is on for the pinned Jev 1.13 model.',
  'verification.message.stopped':
    'Verification budget stopped. No new request can be sent until you switch it on again. A request that was already sent may still be charged, and its reservation stays held as unknown; stopping does not refund it.',

  ...captureEn,
} as const;