#!/usr/bin/env node
// Reads the file the side panel's "导出复核标注" button writes and reports how the
// live filter agrees with what you decided in the timeline.
//
//   node scripts/review-labels-report.mjs <anyfilter-review-labels-*.json> [--out DIR]
//
// These labels were made while the model's verdict was on screen, so they are
// hinted data: read disagreements as "look here", never as an answer key. The
// script only reads and reports; it changes no rule and no threshold.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SNIPPET = 90;

function textOf(record) {
  try {
    const state = JSON.parse(record.stateJson);
    return typeof state.text === 'string' ? state.text.replace(/\s+/g, ' ').trim() : '';
  } catch {
    return '';
  }
}

function snippet(record) {
  const text = textOf(record);
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text;
}

export function parseReviewExport(raw) {
  const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!body || body.kind !== 'anyfilter-review-labels' || !Array.isArray(body.records)) {
    throw new Error('not an AnyFilter review-label export');
  }
  return body.records;
}

/** Model outcome of one record: did any rule fire. */
function modelSide(record) {
  return record.snapshot.state; // kept | flagged | undecided
}

export function buildReport(records) {
  const judged = records.filter((record) => record.overall !== null);
  const byOverall = { hide: 0, keep: 0, uncertain: 0 };
  const matrix = {};
  for (const record of judged) {
    byOverall[record.overall] += 1;
    const cell = (matrix[modelSide(record)] ??= { hide: 0, keep: 0, uncertain: 0 });
    cell[record.overall] += 1;
  }

  // Post level: the person decided hide/keep, the filter flagged or kept.
  const decided = judged.filter((record) => record.overall !== 'uncertain' && modelSide(record) !== 'undecided');
  const agree = decided.filter(
    (record) => (record.overall === 'hide') === (modelSide(record) === 'flagged'),
  );
  const overHidden = decided.filter((record) => modelSide(record) === 'flagged' && record.overall === 'keep');
  const missed = decided.filter((record) => modelSide(record) === 'kept' && record.overall === 'hide');

  // Rule level: only rules the person ticked were judged. `match` = should fire,
  // `no-match` = should not; anything else says nothing about that rule.
  const perRule = {};
  for (const record of judged) {
    const scores = new Map(record.snapshot.rules.map((rule) => [rule.ruleId, rule]));
    for (const tag of record.rules) {
      if (tag.label === 'insufficient') continue;
      const rule = scores.get(tag.ruleId);
      if (!rule) continue;
      const stat = (perRule[tag.ruleId] ??= { tp: 0, fp: 0, fn: 0, tn: 0, fnScores: [], fpScores: [], threshold: rule.threshold });
      const should = tag.label === 'match';
      if (should && rule.hit) stat.tp += 1;
      else if (should) {
        stat.fn += 1;
        if (rule.score !== null) stat.fnScores.push(rule.score);
      } else if (rule.hit) {
        stat.fp += 1;
        if (rule.score !== null) stat.fpScores.push(rule.score);
      } else stat.tn += 1;
    }
  }
  for (const stat of Object.values(perRule)) {
    stat.fnScores.sort((a, b) => b - a);
    stat.fpScores.sort((a, b) => a - b);
  }

  const noRule = judged
    .filter((record) => record.overall === 'hide' && record.noRuleCovers)
    .map((record) => ({ sampleId: record.sampleId, why: record.noRuleCovers, text: snippet(record) }));

  return {
    total: records.length,
    judged: judged.length,
    valuableOnly: records.length - judged.length,
    valuable: records.filter((record) => record.valuable).length,
    byOverall,
    matrix,
    postLevel: {
      compared: decided.length,
      agree: agree.length,
      overHidden: overHidden.map((record) => ({ sampleId: record.sampleId, text: snippet(record) })),
      missed: missed.map((record) => ({ sampleId: record.sampleId, text: snippet(record) })),
    },
    perRule,
    noRule,
  };
}

function pct(part, whole) {
  return whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`;
}

export function renderMarkdown(report) {
  const lines = ['# 复核标注报告', ''];
  lines.push('> 这些标注是在看到模型判断的情况下做的（辅助标注）。分歧只表示“值得再看”，不是标准答案。', '');
  lines.push(
    `- 标注总数 ${report.total}，其中有结论 ${report.judged}，仅标“值得看” ${report.valuableOnly}，值得看合计 ${report.valuable}`,
    `- 结论：应隐藏 ${report.byOverall.hide} · 应保留 ${report.byOverall.keep} · 不确定 ${report.byOverall.uncertain}`,
    '',
    '## 过滤器 × 你的结论',
    '',
    '| 过滤器结果 | 应隐藏 | 应保留 | 不确定 |',
    '| --- | ---: | ---: | ---: |',
  );
  for (const [state, cell] of Object.entries(report.matrix)) {
    lines.push(`| ${state} | ${cell.hide} | ${cell.keep} | ${cell.uncertain} |`);
  }
  const post = report.postLevel;
  lines.push(
    '',
    `一致率（不含不确定/未判定）：${post.agree}/${post.compared}（${pct(post.agree, post.compared)}）`,
    '',
    `### 过滤器隐藏、你认为应保留（${post.overHidden.length}）`,
    '',
    ...post.overHidden.map((item) => `- \`${item.sampleId}\` ${item.text}`),
    '',
    `### 过滤器保留、你认为应隐藏（${post.missed.length}）`,
    '',
    ...post.missed.map((item) => `- \`${item.sampleId}\` ${item.text}`),
    '',
    '## 按规则（仅你勾选过的规则）',
    '',
    '| 规则 | 该触发且触发 | 不该触发却触发 | 该触发未触发 | 不该触发未触发 | 阈值 | 漏掉的最高分 | 误伤的最低分 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const [ruleId, stat] of Object.entries(report.perRule)) {
    lines.push(
      `| ${ruleId} | ${stat.tp} | ${stat.fp} | ${stat.fn} | ${stat.tn} | ${stat.threshold ?? '—'} | ${stat.fnScores[0] ?? '—'} | ${stat.fpScores[0] ?? '—'} |`,
    );
  }
  lines.push('', '## “没有规则能覆盖”的应隐藏帖子', '');
  lines.push(...(report.noRule.length ? report.noRule.map((item) => `- \`${item.sampleId}\` ${item.why} —— ${item.text}`) : ['- 无']));
  lines.push('');
  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outDir = resolve(outIndex >= 0 ? args[outIndex + 1] : 'tmp/evaluation-samples');
  const file = args.find((arg, index) => !arg.startsWith('--') && (outIndex < 0 || index !== outIndex + 1));
  if (!file) {
    console.error('用法：node scripts/review-labels-report.mjs <导出文件.json> [--out 目录]');
    process.exit(2);
  }
  const report = buildReport(parseReviewExport(readFileSync(resolve(file), 'utf8')));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'review-labels-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(outDir, 'review-labels-report.md'), renderMarkdown(report));
  console.log(`已写入 ${resolve(outDir, 'review-labels-report.md')}（标注 ${report.total}，一致 ${report.postLevel.agree}/${report.postLevel.compared}）`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv);
