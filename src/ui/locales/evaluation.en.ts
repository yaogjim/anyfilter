/**
 * English UI resources for the real-evaluation section of the side panel.
 *
 * Wording that must survive any edit, in both languages: a run sends the stored
 * post text to the chosen provider with the person's own key; the spending cap is
 * a local estimate and not a provider-enforced limit; an unknown charge keeps its
 * reservation; a model's answer is a candidate label and not a human label; and
 * the exported file contains post text.
 */
export const evaluationEn = {
  'evaluation.heading': 'Real evaluation',
  'evaluation.intro':
    'Runs one model over every stored sample and every enabled semantic rule, and records what it says. Nothing here changes what the feed hides.',
  'evaluation.size': '{samples} stored samples × {rules} enabled semantic rules = up to {tasks} requests per model (a rule that only applies to replies is skipped for posts without a parent).',
  'evaluation.noTasks': 'Capture some samples and enable a semantic rule first.',

  'evaluation.budget.heading': 'Budget',
  'evaluation.budget.off': 'The budget is off. No request can be sent until it is turned on.',
  'evaluation.budget.partial': 'The budget was switched on before OpenAI and DeepSeek were added. Turn it on again to add their price and cap rows; nothing already spent changes.',
  'evaluation.budget.on': 'The budget is on. Each model has its own price, cap and spend.',
  'evaluation.budget.turnOn': 'Turn on the budget',
  'evaluation.budget.turnOnFailed': 'Could not turn the budget on: {detail}',
  'evaluation.budget.row': '{label}: spent {spent} of {cap} · held {held} · {settled} answered · {open} open',
  'evaluation.budget.note':
    'The cap is a local estimate at the prices read on {checked}, not a limit the provider enforces. A request that may already have been charged keeps its reservation and is never sent again.',

  'evaluation.keys.heading': 'Keys',
  'evaluation.keys.jev': 'Jev uses the TypeSafe key from Settings.',
  'evaluation.keys.jevSet': 'TypeSafe key: set',
  'evaluation.keys.jevMissing': 'TypeSafe key: not set',
  'evaluation.keys.openai': 'OpenAI key',
  'evaluation.keys.deepseek': 'DeepSeek key',
  'evaluation.keys.placeholder': 'Paste a key',
  'evaluation.keys.set': 'Stored',
  'evaluation.keys.missing': 'Not set',
  'evaluation.keys.save': 'Save',
  'evaluation.keys.clear': 'Remove',
  'evaluation.keys.invalid': 'That does not look like a key.',
  'evaluation.connection.model': 'Model',
  'evaluation.connection.baseUrl': 'Base URL',
  'evaluation.connection.save': 'Use',
  'evaluation.connection.invalid': 'The base URL must be an https address without credentials or query.',
  'evaluation.keys.note':
    'Keys stay in this browser profile. They are used only for the requests you start here and can never be read back.',

  'evaluation.run.heading': 'Run',
  'evaluation.run.authorize':
    'I authorize sending the stored posts to {label} with my key, within its cap. This may be charged and cannot be recalled.',
  'evaluation.run.start': 'Run {label}',
  'evaluation.run.stop': 'Stop',
  'evaluation.run.refused': 'Not started: {detail}',
  'evaluation.run.needKey': 'Add a key for this model first.',
  'evaluation.run.needBudget': 'Turn on the budget first.',
  'evaluation.run.running': 'Running {label}…',
  'evaluation.run.progress':
    '{started} of {total} started · {recorded} answered · {repeats} already had an answer · {skipped} skipped · {failed} failed',
  'evaluation.run.done': 'Finished.',
  'evaluation.run.halt.budget': 'Stopped: the budget refused the next request.',
  'evaluation.run.halt.key': 'Stopped: no key for this model.',
  'evaluation.run.halt.storage': 'Stopped: the local store failed.',
  'evaluation.run.halt.stopped': 'Stopped by you. Requests already sent still finish.',
  'evaluation.run.halt.failures': 'Stopped: several requests in a row failed.',
  'evaluation.run.halt.ceiling': 'Stopped at the task ceiling.',
  'evaluation.run.halt.inactive': 'Stopped: the budget was switched off.',
  'evaluation.run.detail': 'Detail: {detail}',

  'evaluation.export.heading': 'Export',
  'evaluation.export.button': 'Save results file',
  'evaluation.export.note':
    'The file contains post text. Keep it private and save it in tmp/evaluation-samples. It holds no key.',
  'evaluation.export.failed': 'Could not build the file.',
  'evaluation.export.saved': 'Saved {samples} samples and {results} answers.',
} as const;
