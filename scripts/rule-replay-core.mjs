// Replay a candidate rule pack against human labels and say whether it may ship.
// Pure logic: the model call is a `scorer` the caller passes in, so tests never
// touch a network. Nothing here applies a rule; a person decides after reading
// the report.
import { hashString, builtInRules, parseRule } from '../src/domain/rule';
import { compileRules } from '../src/domain/rule-compiler';

export const PACK_KIND = 'anyfilter-rule-pack';

/** Gate defaults. A threshold or wording change needs enough of both classes to
 * mean anything; a new rule needs more, because it can hide a whole new kind of
 * post. */
export const DEFAULT_GATES = {
  minPerClass: 30,
  minTotalNewRule: 100,
  /** New false hides allowed, as a share of the labelled keeps (rounded up). */
  maxNewFalseHideRate: 0.03,
};

export function parseRulePack(raw) {
  const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!body || body.kind !== PACK_KIND || body.version !== 1 || !Array.isArray(body.rules)) {
    throw new Error('not an AnyFilter rule pack (version 1)');
  }
  const rules = body.rules.map((rule) => {
    const parsed = parseRule(rule);
    if (!parsed.ok) throw new Error(`rule pack: ${parsed.detail}`);
    return parsed.rule;
  });
  return { name: String(body.name ?? ''), note: String(body.note ?? ''), rules };
}

/** What the pack does to a rule set: a rule with the same id is replaced, any
 * other is appended, and no other rule is touched. `apply-rule-pack` does the
 * same to the stored rules, so the replay judges exactly what would ship. */
export function overlayPack(base, pack) {
  const byId = new Map(pack.rules.map((rule) => [rule.id, rule]));
  const rules = base.rules.map((rule) => byId.get(rule.id) ?? rule);
  for (const rule of pack.rules) if (!base.rules.some((existing) => existing.id === rule.id)) rules.push(rule);
  return { name: pack.name, note: pack.note, rules };
}

export function builtinPack() {
  return { name: 'builtin', note: 'the ten built-in rules as shipped', rules: builtInRules() };
}

/** Human labels from one or more review exports. A post labelled twice keeps
 * its label only when both agree; a contradiction is dropped and counted. */
export function mergeLabels(exports) {
  const byState = new Map();
  let conflicts = 0;
  for (const records of exports) {
    for (const record of records) {
      if (record.overall !== 'hide' && record.overall !== 'keep') continue;
      const seen = byState.get(record.stateJson);
      if (!seen) byState.set(record.stateJson, { record, dropped: false });
      else if (!seen.dropped && seen.record.overall !== record.overall) {
        seen.dropped = true;
        conflicts += 1;
      }
    }
  }
  const labels = [...byState.values()].filter((entry) => !entry.dropped).map((entry) => entry.record);
  return { labels, conflicts };
}

/** Score every label with every model rule of `rules`. A local rule (the ad
 * detector) is read from what the page had recorded. */
export async function scoreRules(rules, labels, scorer) {
  const { questions } = compileRules(rules);
  const scores = labels.map(() => ({}));
  const jobs = [];
  labels.forEach((label, index) => {
    for (const [ruleId, question] of Object.entries(questions)) {
      jobs.push(async () => {
        scores[index][ruleId] = await scorer(label.stateJson, ruleId, question);
      });
    }
    for (const rule of rules) {
      if (!rule.enabled || rule.kind !== 'local') continue;
      const seen = label.snapshot.rules.find((candidate) => candidate.ruleId === rule.id);
      scores[index][rule.id] = seen?.hit ? 1 : 0;
    }
  });
  await runLimited(jobs, 6);
  return scores;
}

async function runLimited(jobs, width) {
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < jobs.length) await jobs[next++]();
    }),
  );
}

/** Whether one post would be hidden under `rules` at `threshold`. */
export function hides(rules, scores, threshold) {
  return rules.some((rule) => {
    if (!rule.enabled) return false;
    const score = scores[rule.id];
    if (typeof score !== 'number') return false;
    return score >= (rule.threshold ?? threshold);
  });
}

function tally(rules, labels, scores, threshold) {
  let caught = 0;
  let falseHide = 0;
  const decisions = labels.map((label, index) => {
    const hidden = hides(rules, scores[index], threshold);
    if (hidden && label.overall === 'hide') caught += 1;
    if (hidden && label.overall === 'keep') falseHide += 1;
    return hidden;
  });
  return { caught, falseHide, decisions };
}

export function auc(pos, neg) {
  if (pos.length === 0 || neg.length === 0) return null;
  let win = 0;
  for (const p of pos) for (const n of neg) win += p > n ? 1 : p === n ? 0.5 : 0;
  return win / (pos.length * neg.length);
}

function maxScore(rules, scores) {
  let best = 0;
  for (const rule of rules) if (rule.enabled && typeof scores[rule.id] === 'number') best = Math.max(best, scores[rule.id]);
  return best;
}

export function compareRuleSets({ base, candidate, labels, baseScores, candidateScores, threshold }) {
  const nHide = labels.filter((label) => label.overall === 'hide').length;
  const nKeep = labels.length - nHide;
  const b = tally(base.rules, labels, baseScores, threshold);
  const c = tally(candidate.rules, labels, candidateScores, threshold);
  let gained = 0;
  let lost = 0;
  let newFalseHide = 0;
  let fixedFalseHide = 0;
  labels.forEach((label, index) => {
    const was = b.decisions[index];
    const now = c.decisions[index];
    if (label.overall === 'hide') {
      if (!was && now) gained += 1;
      if (was && !now) lost += 1;
    } else {
      if (!was && now) newFalseHide += 1;
      if (was && !now) fixedFalseHide += 1;
    }
  });
  const scoreAuc = (rules, scores) =>
    auc(
      labels.flatMap((label, i) => (label.overall === 'hide' ? [maxScore(rules, scores[i])] : [])),
      labels.flatMap((label, i) => (label.overall === 'keep' ? [maxScore(rules, scores[i])] : [])),
    );
  const baseIds = new Set(base.rules.map((rule) => rule.id));
  const changedRules = candidate.rules.filter((rule) => {
    const before = base.rules.find((other) => other.id === rule.id);
    return !before || JSON.stringify(before) !== JSON.stringify(rule);
  });
  return {
    nHide,
    nKeep,
    threshold,
    base: { caught: b.caught, falseHide: b.falseHide, auc: scoreAuc(base.rules, baseScores) },
    candidate: { caught: c.caught, falseHide: c.falseHide, auc: scoreAuc(candidate.rules, candidateScores) },
    gained,
    lost,
    newFalseHide,
    fixedFalseHide,
    newRuleIds: changedRules.filter((rule) => !baseIds.has(rule.id)).map((rule) => rule.id),
    changedRuleIds: changedRules.filter((rule) => baseIds.has(rule.id)).map((rule) => rule.id),
  };
}

/** Each gate is `pass`, `fail` or `insufficient`. Any fail blocks; too little
 * data cannot pass, it can only say it does not know. */
export function judge(comparison, gates = DEFAULT_GATES) {
  const { nHide, nKeep, gained, lost, newFalseHide, newRuleIds, changedRuleIds } = comparison;
  const results = [];
  if (newRuleIds.length + changedRuleIds.length === 0) {
    results.push({ name: 'has-change', status: 'fail', detail: 'the pack changes nothing compared with the base' });
  }
  const allowed = Math.ceil(gates.maxNewFalseHideRate * nKeep);
  results.push({
    name: 'false-hide',
    status: newFalseHide <= allowed ? 'pass' : 'fail',
    detail: `${newFalseHide} newly hidden posts you wanted to keep (allowed ${allowed} of ${nKeep})`,
  });
  results.push({
    name: 'net-gain',
    status: gained - lost > newFalseHide ? 'pass' : 'fail',
    detail: `${gained} newly caught, ${lost} no longer caught, ${newFalseHide} new false hides`,
  });
  const enough = nHide >= gates.minPerClass && nKeep >= gates.minPerClass;
  results.push({
    name: 'enough-labels',
    status: enough ? 'pass' : 'insufficient',
    detail: `${nHide} hide and ${nKeep} keep labels (need ${gates.minPerClass} of each)`,
  });
  if (newRuleIds.length > 0) {
    const total = nHide + nKeep;
    results.push({
      name: 'enough-labels-new-rule',
      status: total >= gates.minTotalNewRule ? 'pass' : 'insufficient',
      detail: `${total} labels in total (a new rule needs ${gates.minTotalNewRule})`,
    });
  }
  const verdict = results.some((r) => r.status === 'fail')
    ? 'fail'
    : results.some((r) => r.status === 'insufficient')
      ? 'insufficient-data'
      : 'pass';
  return { verdict, results };
}

export function packFingerprint(pack) {
  return hashString(JSON.stringify(pack.rules));
}

export function renderReport({ base, candidate, comparison, judgement, conflicts, spend, labelFiles }) {
  const pct = (part, whole) => (whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`);
  const fmt = (value) => (value === null ? '—' : value.toFixed(2));
  const verdictText = { pass: '通过（仍需你确认后才上线）', fail: '不通过', 'insufficient-data': '数据不足，不能判定' }[judgement.verdict];
  const c = comparison;
  const lines = [
    '# 规则重放报告',
    '',
    `结论：**${verdictText}**`,
    '',
    `- 基线：${base.name}（${base.rules.length} 条规则）；候选：${candidate.name}（${candidate.rules.length} 条，指纹 ${packFingerprint(candidate)}）`,
    `- 标注：应隐藏 ${c.nHide} · 应保留 ${c.nKeep}（来源 ${labelFiles.length} 个文件${conflicts ? `，${conflicts} 条前后矛盾已剔除` : ''}）；阈值 ${c.threshold}`,
    `- 新增规则：${c.newRuleIds.join(', ') || '无'}；改动规则：${c.changedRuleIds.join(', ') || '无'}`,
    `- 花费：${spend.calls} 次新请求，约 ${spend.usd.toFixed(4)} 美元`,
    '',
    '| | 抓到的应隐藏 | 误伤的应保留 | 区分能力 (AUC) |',
    '| --- | ---: | ---: | ---: |',
    `| 基线 | ${c.base.caught}/${c.nHide}（${pct(c.base.caught, c.nHide)}） | ${c.base.falseHide}/${c.nKeep} | ${fmt(c.base.auc)} |`,
    `| 候选 | ${c.candidate.caught}/${c.nHide}（${pct(c.candidate.caught, c.nHide)}） | ${c.candidate.falseHide}/${c.nKeep} | ${fmt(c.candidate.auc)} |`,
    '',
    `新抓到 ${c.gained}，不再抓到 ${c.lost}，新增误伤 ${c.newFalseHide}，消除误伤 ${c.fixedFalseHide}。`,
    '',
    '## 门槛',
    '',
    ...judgement.results.map((r) => `- ${{ pass: '通过', fail: '不通过', insufficient: '数据不足' }[r.status]}｜${r.name}：${r.detail}`),
    '',
    '标注来自复核模式时是看着模型判断做的，只是参考；金标集是没看过模型意见的盲标。这份报告不会应用任何规则。',
    '',
  ];
  return lines.join('\n');
}
