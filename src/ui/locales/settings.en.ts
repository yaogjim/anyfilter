/**
 * English UI strings for the settings panel (translate-key resource).
 * Keys are identifiers only: components never pass English/Chinese pairs.
 * Placeholders use the shared `{name}` syntax. Rule text, compiled
 * instructions and provider responses are never stored here.
 */
export const settingsEn = {
  'settings.appearance': 'Appearance',
  'settings.interfaceLanguage': 'Interface language',
  'settings.languageSwitchNote':
    'This only changes the language of this interface. Your rules are original text: switching language never translates, rewrites or re-scores them, and rule names stay exactly as you typed them.',
  'settings.localeLoadError':
    'Could not load the language preference. English is used until you choose a language.',
  'settings.localeSaveError': 'Could not save the language preference.',
  'settings.provider': 'Provider',
  'settings.apiKey': 'API key',
  'settings.apiKeyPlaceholder': '{hint} — stored only in this browser',
  'settings.apiKeyPrivacyNote':
    'Your key never leaves this browser except to the provider you picked. Without a key only ads are hidden.',
  'settings.threshold': 'Threshold',
  'settings.thresholdProbabilityAtLeast':
    "Hide a post when the model's probability is at least",
  'settings.hideMore': 'Hide more',
  'settings.hideLess': 'Hide less',
  'settings.thresholdNote':
    "This is the model's probability for a rule, not an accuracy rate. Rules whose wording is vague will score less reliably.",
  'settings.data': 'Data',
  'settings.clearHiddenPosts': 'Clear hidden posts',
  'settings.clearHiddenReplies': 'Clear hidden replies',
  'settings.clearEverything': 'Clear everything',
  'settings.clearEverythingNote':
    'Clearing everything also resets the counters and forgets cached scores. Settings, rules and your key stay.',
  'settings.rules': 'Rules',
  'settings.rulesIntro':
    'Choose a rule to edit its meaning. Changes stay in this tab until you save.',
  'settings.newRule': 'New rule',
  'settings.searchRules': 'Search rules',
  'settings.searchRulesPlaceholder': 'Search rules…',
  'settings.filterRules': 'Filter rules',
  'settings.sourceAll': 'All',
  'settings.sourceBuiltIn': 'Built-in',
  'settings.sourceCustom': 'Custom',
  'settings.enableRule': 'Enable {name}',
  'settings.kindOnPageCheck': 'On-page check',
  'settings.kindJevQuestion': 'Jev question',
  'settings.noRulesMatch': 'No rules match this search.',
  'settings.fixedLocalDetector': 'Fixed local detector',
  'settings.describeMatchIntro':
    'Describe the match, exclusions and examples below. You can inspect the exact question sent to Jev.',
  'settings.selectRuleHint': 'Select a rule on the left to edit it.',
  'settings.builtInRulesNote':
    'All ten built-in rules start enabled, but their accuracy has not been verified. Ads use a local page marker; text rules need an API key and send their questions to Jev.',
  'settings.saving': 'Saving…',
  'settings.saveAndApply': 'Save and apply',
  'settings.cancel': 'Cancel',
  'settings.unsavedChanges': 'Unsaved changes',
  'settings.saveRescoreNote':
    'Saving re-scores posts affected by a changed rule. Renaming a rule or changing only its threshold reuses cached scores. Cancel leaves the saved rules untouched.',
  'settings.reload': 'Reload',
  'settings.rulesSaved': 'Rules saved and applied.',
  'settings.rulesSavedWithNewerEdits': 'Saved. Your newer edits are still unsaved.',
  'settings.rulesConflict':
    'Rules changed in another panel since you started editing. Reload to get the latest before saving.',
  'settings.rulesSaveFailed': 'Could not save rules: {detail}',
  'settings.rulesReloaded': 'Reloaded the latest saved rules.',
  'settings.testTextTitle': 'Test a text',
  'settings.testDraftIntro':
    'Test your current draft before saving. This sends only the text you enter to your chosen provider and does not change the feed.',
  'settings.examplePlaceholder': 'An example post for this category',
  'settings.exampleAria': '{title} example {index}',
  'settings.removeExampleAria': 'Remove {title} example {index}',
  'settings.addExample': 'Add example',
  'settings.useDifferentThreshold': 'Use a different threshold for this rule',
  'settings.hideWhenProbabilityAtLeast':
    "Hide when the model's probability is at least",
  'settings.usesOverallThreshold':
    "Uses the overall threshold above, which is the model's probability for a rule.",
  'settings.localCheckNote':
    'Local check. Posts are hidden when the page marks them as a promoted ad. This rule reads page signals only, so there is no prompt, examples, or threshold to edit — you can only turn it on or off.',
  'settings.originalRuleTextNote':
    'Everything below is original rule text. It is stored exactly as you write it and is never translated or rewritten when you switch the interface language, including the rule name.',
  'settings.hideWhen': 'Hide when',
  'settings.includePlaceholder': 'Describe what this rule should filter out…',
  'settings.exceptWhen': 'Except when (optional)',
  'settings.excludePlaceholder': 'Describe what should always be kept…',
  'settings.shouldHide': 'Should hide',
  'settings.shouldNotHide': 'Should not hide',
  'settings.appliesTo': 'Applies to',
  'settings.allPosts': 'All posts',
  'settings.repliesOnlyNeedsParent': 'Replies only (needs parent)',
  'settings.showInstruction': 'Show the exact instruction sent to Jev',
  'settings.hideInstruction': 'Hide the exact instruction sent to Jev',
  'settings.deleteRule': 'Delete rule',
  'settings.enabled': 'Enabled',
  'settings.ruleName': 'Rule name',
  'settings.local': 'Local',
  'settings.closeRuleEditor': 'Close rule editor',
  'settings.editRule': 'Edit rule',
  'settings.edit': 'Edit',
  'settings.previewTextToTest': 'Text to test',
  'settings.previewTextPlaceholder':
    'Paste one post or reply to see how the draft rules would judge it…',
  'settings.previewHideContext': 'Hide context',
  'settings.previewAddContext': 'Add context (author, quote, parent)',
  'settings.previewAuthorName': 'Author name',
  'settings.previewHandle': 'Handle',
  'settings.previewQuotedPost': 'Quoted post',
  'settings.previewParentPost': 'Parent post (for replies)',
  'settings.previewTesting': 'Testing…',
  'settings.previewTestText': 'Test text',
  'settings.previewSendsNote':
    'Sends this text to your provider and may cost tokens. Nothing is saved.',
  'settings.previewStaleNote':
    'The text, context, threshold, or rules changed after this test. Test again to refresh it.',
  'settings.previewScoreNote':
    'Each score is the model\'s probability that the post matches that rule; “would hide” means it reached the threshold.',
  'settings.previewModelProbabilityTitle': 'Model probability vs threshold',
  'settings.previewInputTokens': 'input tokens',
  'settings.statusWouldHide': 'would hide',
  'settings.statusBelowThreshold': 'below threshold',
  'settings.statusNoScore': 'no score',
  'settings.statusNotApplicable': 'not applicable',
  'settings.previewErrorNoKey': 'Add an API key in Settings before testing.',
  'settings.previewErrorAuth':
    'The provider rejected your API key (401/403). Check it in Settings.',
  'settings.previewErrorRateLimited': 'The provider is rate-limiting this key.',
  'settings.previewErrorRateLimitedWithDetail':
    'The provider is rate-limiting this key: {detail}',
  'settings.previewErrorNetwork': 'Could not reach the provider: {detail}',
  'settings.previewErrorBadResponse': 'Unexpected provider response: {detail}',
} as const;