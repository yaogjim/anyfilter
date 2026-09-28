#!/usr/bin/env node
/**
 * Offline rule-evaluation report.
 *
 * This tool is COMPLETELY OFFLINE by default and never contacts a provider. It
 * scores a small, hand-labelled sample set with an explicitly illustrative
 * keyword scorer so that the metric plumbing (precision, recall, false-hide,
 * missed-hide, undecided rate, Wilson 95% intervals, micro-average) can be run in
 * CI without spending money.
 *
 * The numbers it prints are NOT evidence about Jev's quality. They measure a toy
 * scorer against a tiny fixture. Run a real evaluation only by hand, with an
 * explicit budget and authorisation; `--remote` refuses to do it for you and
 * prints the manual procedure instead.
 *
 * Usage:
 *   node --import ./scripts/ts-loader.mjs scripts/eval-rules.mjs [--json]
 *   node scripts/eval-rules.mjs            # re-launches itself with the loader
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');

const REMOTE_AUTHORIZATION_ENV = 'ANYFILTER_EVAL_ALLOW_REMOTE';
const REMOTE_KEY_ENV = 'ANYFILTER_EVAL_KEY';
const STATUS_ORDER = ['match', 'no-match', 'undecided'];

/** Hand-labelled fixtures. Small on purpose: this is scaffolding, not a dataset. */
const SAMPLES = [
  // Engagement bait
  { rule: 'bait', expect: 'match', text: 'Comment a colour below and I will follow everyone who does' },
  { rule: 'bait', expect: 'match', text: 'Drop a fire emoji and introduce yourself in the replies' },
  { rule: 'bait', expect: 'no-match', text: 'I benchmarked three query planners this week; here is the plan output' },
  { rule: 'bait', expect: 'no-match', text: 'Which database do you use for analytics, and why?' },
  // Promo / selling
  { rule: 'promo', expect: 'match', text: 'Buy my course and use discount code SHIPIT for 40 percent off' },
  { rule: 'promo', expect: 'match', text: 'New newsletter issue is out, link in bio to subscribe' },
  { rule: 'promo', expect: 'no-match', text: 'I tried the new release for two weeks and it broke on our CI' },
  { rule: 'promo', expect: 'no-match', text: 'A review of the pricing page: the free tier is the honest part' },
  // Platitudes
  { rule: 'platitude', expect: 'match', text: 'Remember to be kind. Hard work always pays off in the end' },
  { rule: 'platitude', expect: 'match', text: 'Trust the process and never stop believing in yourself' },
  { rule: 'platitude', expect: 'no-match', text: 'We cut p99 latency from 800ms to 90ms by caching the join result' },
  { rule: 'platitude', expect: 'no-match', text: 'Sorry your launch slipped; that sounds genuinely exhausting' },
  // Hate & insults
  { rule: 'hate', expect: 'match', text: 'people from that country are all parasites and should be kicked out' },
  { rule: 'hate', expect: 'match', text: 'he is a subhuman idiot and everyone who voted for him is scum' },
  { rule: 'hate', expect: 'no-match', text: 'The article is wrong on the data, but the author is not a bad person' },
  { rule: 'hate', expect: 'no-match', text: 'Reporting on the slur used at the rally, quoted here so it can be condemned' },
  // Politics
  { rule: 'politics', expect: 'match', text: 'The parliament vote on the election bill failed by two seats' },
  { rule: 'politics', expect: 'match', text: 'Political parties keep promising the same thing every cycle' },
  { rule: 'politics', expect: 'no-match', text: 'Shipped the migration script today; the deploy window was quiet' },
  { rule: 'politics', expect: 'no-match', text: 'I met my old manager for coffee and we talked about hiking' },
  // NSFW text only
  { rule: 'nsfw', expect: 'match', text: 'nsfw thread, explicit description of a sexual act below' },
  { rule: 'nsfw', expect: 'match', text: 'gore warning: the accident footage is graphic and shown in the post' },
  { rule: 'nsfw', expect: 'no-match', text: 'The medical textbook chapter covers reproductive anatomy for students' },
  { rule: 'nsfw', expect: 'no-match', text: 'A news report about the flood, no graphic imagery included' },
  // Porn bots
  { rule: 'porn', expect: 'match', text: 'my OF is free, dm me and link in bio' },
  { rule: 'porn', expect: 'match', text: '我福不黑不信你看, 看主页, 私信' },
  { rule: 'porn', expect: 'no-match', text: 'Warning: these accounts send the same line, my OF is free, then a link' },
  { rule: 'porn', expect: 'no-match', text: 'Creepy DMs are getting worse; here is how I report them' },
  // Spam / bot replies
  { rule: 'spam', expect: 'match', text: 'follow me back and lets grow together, dm me' },
  { rule: 'spam', expect: 'match', text: '繋がりましょう, フォロバお願いします' },
  { rule: 'spam', expect: 'no-match', text: 'Could you verify this number against the vendor report?' },
  { rule: 'spam', expect: 'no-match', text: 'Good thread. I disagree with the second point though, here is why' },
  // Crypto shilling
  { rule: 'crypto', expect: 'match', text: 'Last chance to join the presale before this token does 100x' },
  { rule: 'crypto', expect: 'match', text: 'Free airdrop for holders, connect your wallet now' },
  { rule: 'crypto', expect: 'no-match', text: 'This contract drained 4M from users; do not interact with it' },
  { rule: 'crypto', expect: 'no-match', text: 'An analysis of settlement throughput comparing two chains' },
];

/** Illustrative keyword scorer. Deliberately imperfect; not a model. */
const SIGNALS = {
  bait: ['comment a', 'drop a', 'introduce yourself', 'follow everyone'],
  promo: ['buy my', 'my course', 'discount code', 'link in bio', 'subscribe'],
  platitude: ['be kind', 'hard work', 'trust the process', 'never stop believing'],
  hate: ['parasites', 'subhuman', 'scum', 'should be kicked out'],
  politics: ['parliament', 'election', 'political parties'],
  nsfw: ['explicit', 'sexual act', 'gore', 'graphic'],
  porn: ['my of is free', 'dm me', '看主页', '私信', '我福不黑'],
  spam: ['follow me back', 'grow together', 'フォロバ', '繋がりましょう'],
  crypto: ['presale', 'airdrop', '100x', 'connect your wallet'],
};

function offlineScore(ruleId, text) {
  const haystack = text.toLowerCase();
  return (SIGNALS[ruleId] ?? []).some((signal) => haystack.includes(signal)) ? 1 : 0;
}

/** Wilson score interval; returns null when there is nothing to measure. */
function wilson(successes, total, z = 1.96) {
  if (total <= 0) return null;
  const phat = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = phat + (z * z) / (2 * total);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total);
  return [Math.max(0, (centre - margin) / denominator), Math.min(1, (centre + margin) / denominator)];
}

function divide(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function tally(rows) {
  const counts = { tp: 0, fp: 0, tn: 0, fn: 0, undecided: 0 };
  for (const row of rows) {
    if (row.decided === 'undecided') {
      counts.undecided += 1;
      continue;
    }
    if (row.expect === 'match') {
      if (row.decided === 'match') counts.tp += 1;
      else counts.fn += 1;
    } else if (row.decided === 'match') {
      counts.fp += 1;
    } else {
      counts.tn += 1;
    }
  }
  const total = rows.length;
  return {
    ...counts,
    total,
    precision: divide(counts.tp, counts.tp + counts.fp),
    recall: divide(counts.tp, counts.tp + counts.fn),
    precisionCi: wilson(counts.tp, counts.tp + counts.fp),
    recallCi: wilson(counts.tp, counts.tp + counts.fn),
    undecidedRate: divide(counts.undecided, total),
  };
}

function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function interval(ci) {
  return ci === null ? 'n/a' : `${(ci[0] * 100).toFixed(1)}-${(ci[1] * 100).toFixed(1)}%`;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
    remote: argv.includes('--remote'),
  };
}

/** Loads the extension's TypeScript modules, re-launching with the loader if needed. */
async function loadSources() {
  try {
    const [rule, compiler, adapter] = await Promise.all([
      import('../src/domain/rule.ts'),
      import('../src/domain/rule-compiler.ts'),
      import('../src/infrastructure/jev/vercel-gateway-adapter.ts'),
    ]);
    return { rule, compiler, adapter };
  } catch (error) {
    if (process.env.ANYFILTER_EVAL_RELAUNCHED === '1') throw error;
    const major = Number(process.versions.node.split('.')[0]);
    const flags = major === 22 ? ['--experimental-strip-types'] : [];
    const loader = path.join(ROOT, 'scripts', 'ts-loader.mjs');
    const result = spawnSync(
      process.execPath,
      [...flags, '--import', loader, SELF, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, ANYFILTER_EVAL_RELAUNCHED: '1' } },
    );
    process.exit(result.status ?? 1);
  }
}

function describeRemoteProcedure() {
  return [
    '',
    'Real evaluation is intentionally not wired into this script, so it can never',
    'be triggered by CI, an editor task, or a scheduled job. To evaluate against a',
    'live provider, do it by hand and only with explicit authorisation:',
    '',
    '  1. Confirm the provider, the sample licence, and a hard budget cap for',
    '     requests and tokens.',
    `  2. Export a key for the run: ${REMOTE_KEY_ENV}=...`,
    `  3. Acknowledge the cost explicitly: ${REMOTE_AUTHORIZATION_ENV}=1`,
    '  4. Send the labelled samples through the same compiled questions the',
    '     extension uses, then compute precision/recall per rule and language.',
    '  5. Record the samples, the compiled instruction fingerprint, the model alias',
    '     the API actually returned, and the limits you hit.',
    '',
    'Until that has been done, every rule must be reported as "evidence missing",',
    'never as verified. Model probability is not accuracy.',
    '',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.remote) {
    console.error('REFUSED: --remote never runs automatically.');
    console.error(describeRemoteProcedure());
    process.exit(2);
  }

  const { rule, compiler, adapter } = await loadSources();

  const rules = rule.builtInRules();
  const semanticRules = rules.filter((builtin) => builtin.kind === 'semantic');
  const questions = compiler.compileRules(rules).questions;
  const fingerprint = compiler.questionsFingerprint(questions);

  const rows = SAMPLES.map((sample) => {
    const score = offlineScore(sample.rule, sample.text);
    return {
      ...sample,
      score,
      decided: score === undefined ? 'undecided' : score >= 0.7 ? 'match' : 'no-match',
    };
  });

  const byRule = semanticRules.map((builtin) => ({
    rule: builtin,
    metrics: tally(rows.filter((row) => row.rule === builtin.id)),
  }));
  const combined = tally(rows);
  const skipped = SAMPLES.map((sample) => sample.rule).filter(
    (ruleId) => !semanticRules.some((builtin) => builtin.id === ruleId),
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          mode: 'offline-illustrative',
          compilerVersion: compiler.COMPILER_VERSION,
          questionsFingerprint: fingerprint,
          modelAlias: adapter.vercelGatewayAdapter.model,
          rules: byRule.map(({ rule: builtin, metrics }) => ({ id: builtin.id, ...metrics })),
          combined,
          unknownSampleRules: [...new Set(skipped)],
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('AnyFilter offline rule evaluation');
  console.log('='.repeat(72));
  console.log('Mode            offline, illustrative keyword scorer (NOT Jev quality)');
  console.log(`Compiler        version ${compiler.COMPILER_VERSION}`);
  console.log(`Fingerprint     ${fingerprint}`);
  console.log(`Model alias     ${adapter.vercelGatewayAdapter.model}`);
  console.log(`Samples         ${rows.length} labelled fixtures, ${semanticRules.length} semantic rules`);
  console.log(`Threshold       0.70 (global default)`);
  console.log('');
  console.log(
    `${pad('Rule', 12)}${pad('N', 4)}${pad('Hit', 5)}${pad('Miss', 6)}${pad('False', 7)}` +
      `${pad('Prec', 8)}${pad('Prec 95%', 16)}${pad('Recall', 8)}${pad('Recall 95%', 16)}Undec`,
  );
  console.log('-'.repeat(90));
  for (const { rule: builtin, metrics } of byRule) {
    console.log(
      pad(builtin.id, 12) +
        pad(metrics.total, 4) +
        pad(metrics.tp, 5) +
        pad(metrics.fn, 6) +
        pad(metrics.fp, 7) +
        pad(percent(metrics.precision), 8) +
        pad(interval(metrics.precisionCi), 16) +
        pad(percent(metrics.recall), 8) +
        pad(interval(metrics.recallCi), 16) +
        percent(metrics.undecidedRate),
    );
  }
  console.log('-'.repeat(90));
  console.log(
    pad('combined', 12) +
      pad(combined.total, 4) +
      pad(combined.tp, 5) +
      pad(combined.fn, 6) +
      pad(combined.fp, 7) +
      pad(percent(combined.precision), 8) +
      pad(interval(combined.precisionCi), 16) +
      pad(percent(combined.recall), 8) +
      pad(interval(combined.recallCi), 16) +
      percent(combined.undecidedRate),
  );
  console.log('');
  console.log('Legend: Hit = expected hide and hidden. Miss = expected hide but kept.');
  console.log('        False = expected keep but hidden. Undec = no usable score.');
  console.log('');
  console.log('Caveats, read before quoting any number above:');
  console.log('  - The scorer is a keyword toy. These figures say nothing about Jev.');
  console.log(`  - ${rows.length} fixtures is far too few for the 95% intervals to be tight.`);
  console.log('  - The ads rule is a local page-signal check and is not text-evaluable.');
  console.log('  - Rules are on by default because of user preference, not because they');
  console.log('    have been accuracy-verified. Real evaluation is manual; see --remote.');
  console.log('');

  if (skipped.length > 0) {
    console.log(`Note: fixtures referencing unknown rules: ${[...new Set(skipped)].join(', ')}`);
  }
}

void main();