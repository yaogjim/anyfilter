#!/usr/bin/env node
/**
 * Offline, dependency-free human blind-review entry point.
 *
 * It reads the existing `tmp/evaluation-samples/review-queue.json` and the
 * `canary-home-*.jsonl` / `hard-history-*.jsonl` batches, and renders a local
 * HTML page that shows only what a blind reviewer is allowed to see:
 *   - the captured post state (author, text, quoted, replyingTo) verbatim,
 *   - the rule spec for each current rule (id, label, kind, definition, notes),
 *   - the blind sample group.
 *
 * Labels are per `sampleId` + `ruleId`, matching the project's `RuleEvaluation`
 * contract where overlapping rules stay separate records. The page deliberately
 * does NOT surface the machine outcome, the production hide action, the content
 * group hash, `machines`, `shownByUser` or any Jev score.
 *
 * Outputs are written under `tmp/` (git-ignored) only. Nothing here reaches the
 * network, the environment, an account, a git-tracked file, stdout text, or a
 * screenshot. Human labels are self-reported and never auto-confirmed.
 *
 * Commands:
 *   node scripts/blind-review.mjs prepare [--dir DIR] [--rules FILE] [--suggestions FILE | --assist FILE] [--pairs FILE --html-name NAME]
 *   node scripts/blind-review.mjs apply <submission.json> [--dir DIR] [--allow-rereview]
 *   node scripts/blind-review.mjs verify [--dir DIR]
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The three label states shared with `src/domain/evaluation.ts`. */
export const STATES = ['match', 'no-match', 'undecided'];
export const GROUPS = { holdout: 'holdout', diagnostic: 'diagnostic' };

const SAMPLE_RE = /^(?:canary-home|hard-history|extension-export)-\d{8}T\d{6}\.jsonl$/;
const QUEUE_NAME = 'review-queue.json';
const HTML_NAME = 'blind-review.html';
const TEMPLATE_NAME = 'annotations-template.json';
const STORE_NAME = 'human-labels.json';
const STORE_VERSION = 2;

/** Delimiter for the in-memory review key; never persisted as a key. */
const KEY_SEP = '\u0000';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const orderKey = (value) => sha256(value);

export function recordKey(sampleId, ruleId) {
  return `${sampleId}${KEY_SEP}${ruleId}`;
}

/** Same conservative identifier shape the rule registry accepts. */
function isPlainId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

/** Keys the capture state may carry; anything else is reported, never shown. */
const STATE_KEYS = ['author', 'text', 'quoted', 'replyingTo'];

/** Read the review queue. Only ID arrays and totals are used downstream. */
export function loadQueue(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('review-queue is not an object');
  const idList = (value) => (Array.isArray(value) ? [...new Set(value.filter(isPlainId))] : []);
  return {
    version: raw.version ?? null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    totals: raw.totals && typeof raw.totals === 'object' ? raw.totals : {},
    holdoutIds: idList(raw.blindRandomHoldoutIds),
    diagnosticIds: idList([
      ...(Array.isArray(raw.hiddenDiagnosticIds) ? raw.hiddenDiagnosticIds : []),
      ...(Array.isArray(raw.keptDiagnosticIds) ? raw.keptDiagnosticIds : []),
      ...(Array.isArray(raw.disputedIds) ? raw.disputedIds : []),
    ]),
  };
}

/**
 * Parse the current rule set from `docs/filter-rules.md` section 3. IDs come
 * from the backticked token on each `###` heading, so the leading ordinals are
 * never trusted. `kind` comes from the trailing `(local)`/`(semantic)` marker.
 * The bullet list under each heading becomes `notes`.
 */
export function parseRuleSpec(doc) {
  const lines = String(doc).split('\n');
  const start = lines.findIndex((line) => /^##\s+3\./.test(line));
  if (start < 0) throw new Error('rule spec section "## 3." not found');
  let end = lines.findIndex((line, index) => index > start && /^##\s+\d/.test(line));
  if (end < 0) end = lines.length;

  const rules = [];
  let current = null;
  for (let i = start + 1; i < end; i += 1) {
    const heading = lines[i].match(/^###\s+(.+?)\s*$/);
    if (heading) {
      const text = heading[1];
      const idMatch = text.match(/`([^`]+)`/);
      if (!idMatch) {
        current = null;
        continue;
      }
      const kindMatch = text.match(/\((local|semantic)\)/);
      current = {
        id: idMatch[1].trim(),
        label: text.split('—')[0].replace(/^\s*\d+\.\s*/, '').trim(),
        kind: kindMatch ? kindMatch[1] : 'unknown',
        notes: [],
      };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const bullet = lines[i].match(/^-\s+\*\*(.+?)\.\*\*\s*(.*)$/);
    if (bullet) {
      current.notes.push({ key: bullet[1].trim(), value: bullet[2].trim() });
      continue;
    }
    // A wrapped bullet continues on indented lines; keep the whole sentence.
    const continuation = lines[i].match(/^\s{2,}(\S.*)$/);
    if (continuation && current.notes.length > 0) {
      const last = current.notes[current.notes.length - 1];
      last.value = `${last.value} ${continuation[1].trim()}`.trim();
    }
  }

  if (rules.length === 0) throw new Error('no rules parsed from the spec');
  const seen = new Set();
  for (const rule of rules) {
    if (!isPlainId(rule.id)) throw new Error(`rule id is not a plain id: ${rule.id}`);
    if (seen.has(rule.id)) throw new Error(`duplicate rule id in spec: ${rule.id}`);
    seen.add(rule.id);
  }
  return rules;
}

/** Extract the reviewable state fields from a captured `input` value. */
function extractContext(input) {
  let parsed = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { context: { author: null, text: input, quoted: '', replyingTo: null }, unknownKeys: [] };
    }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const unknownKeys = Object.keys(parsed).filter((key) => !STATE_KEYS.includes(key));
    const author = parsed.author && typeof parsed.author === 'object'
      ? { handle: asString(parsed.author.handle), name: asString(parsed.author.name) }
      : null;
    const parent = parsed.replyingTo;
    const replyingTo = parent && typeof parent === 'object'
      ? { author: asString(parent.author), text: asString(parent.text) }
      : null;
    return {
      context: { author, text: asString(parsed.text), quoted: asString(parsed.quoted), replyingTo },
      unknownKeys,
    };
  }
  return { context: { author: null, text: '', quoted: '', replyingTo: null }, unknownKeys: [] };
}

/**
 * Build a `sampleId -> context` index from the batch files. The machine outcome,
 * the shown action and the Jev score are never read.
 */
export function indexSamples(files) {
  const index = new Map();
  const unknownKeys = new Set();
  for (const { content } of files) {
    const lines = String(content).split('\n').filter((line) => line.trim() !== '');
    // The first line is the batch header; rows follow.
    for (const line of lines.slice(1)) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || !isPlainId(row.sampleId) || index.has(row.sampleId)) continue;
      const { context, unknownKeys: keys } = extractContext(row.input);
      for (const key of keys) unknownKeys.add(key);
      index.set(row.sampleId, context);
    }
  }
  return { index, unknownKeys: [...unknownKeys].sort() };
}

/**
 * Select the blind entries. Holdout and diagnostic IDs are never mixed. The
 * diagnostic list is shuffled by a stable hash so the original hidden-then-kept
 * ordering cannot leak; the two diagnostic sources are indistinguishable.
 */
export function selectBlindEntries(queue, index) {
  const entries = [];
  const missing = [];
  const seen = new Set();
  for (const sampleId of queue.holdoutIds) {
    if (seen.has(sampleId)) continue;
    seen.add(sampleId);
    const context = index.get(sampleId);
    if (!context) {
      missing.push(sampleId);
      continue;
    }
    entries.push({ sampleId, group: GROUPS.holdout, ...context });
  }
  // Diagnostic order is a stable hash so the original hidden-then-kept source
  // ordering cannot leak; the two sources become one indistinguishable group.
  const diagnosticIds = [...new Set(queue.diagnosticIds)]
    .sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
  for (const sampleId of diagnosticIds) {
    if (seen.has(sampleId)) continue;
    seen.add(sampleId);
    const context = index.get(sampleId);
    if (!context) {
      missing.push(sampleId);
      continue;
    }
    entries.push({ sampleId, group: GROUPS.diagnostic, ...context });
  }
  return { entries, missing };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Serialize embedded data so it cannot break out of the `script` element. */
function embedJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function ruleDefinition(rule) {
  const note = (rule.notes || []).find((item) => item.key === 'Definition');
  return note ? note.value : '';
}

/**
 * Render the blind HTML. The embedded data carries the sanitized sample context
 * and the rule spec; no machine field is read or written here.
 */
export function renderHtml(entries, { rules, generatedAt, suggestions = null, pairs = null, translations = null }) {
  // Optional pair restriction: only the listed sample+rule pairs are shown.
  const pairMap = {};
  if (pairs) {
    for (const [sampleId, ruleId] of pairs) (pairMap[sampleId] || (pairMap[sampleId] = [])).push(ruleId);
    entries = entries.filter((entry) => pairMap[entry.sampleId]);
  }
  const items = entries.map((entry) => ({
    sampleId: entry.sampleId,
    group: entry.group,
    author: entry.author,
    text: entry.text,
    quoted: entry.quoted,
    replyingTo: entry.replyingTo,
  }));
  const ruleData = rules.map((rule) => ({
    id: rule.id,
    label: rule.label,
    kind: rule.kind,
    definition: ruleDefinition(rule),
    notes: (rule.notes || []).map((note) => ({ key: note.key, value: note.value })),
  }));
  // Optional model-suggested defaults: { model, records[sampleId][ruleId] = { state, reason } }.
  const suggested = {};
  if (suggestions && suggestions.records && typeof suggestions.records === 'object') {
    for (const item of items) {
      const byRule = suggestions.records[item.sampleId];
      if (!byRule || typeof byRule !== 'object') continue;
      for (const rule of ruleData) {
        const value = byRule[rule.id];
        if (value && STATES.includes(value.state)) {
          (suggested[item.sampleId] || (suggested[item.sampleId] = {}))[rule.id] = { state: value.state, reason: asString(value.reason).slice(0, 200) };
        }
      }
    }
  }
  const data = {
    generatedAt,
    states: STATES,
    rules: ruleData,
    items,
    suggestionModel: Object.keys(suggested).length > 0 ? asString(suggestions.model) : '',
    suggested,
    pairs: pairs ? pairMap : null,
    translations: translations && typeof translations === 'object' ? translations : {},
  };
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>本地人工盲审（预览）</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 900px; padding: 16px 16px 96px; }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; margin-top: 24px; }
  .warn { border-left: 4px solid #d97706; padding: 8px 12px; background: rgba(217,119,6,.12); }
  details { margin: 8px 0; }
  pre { white-space: pre-wrap; word-break: break-word; background: rgba(127,127,127,.12); padding: 8px; }
  .item { border: 1px solid rgba(127,127,127,.4); border-radius: 8px; padding: 12px; margin: 12px 0; }
  .meta { display: flex; gap: 8px; align-items: center; font-size: 12px; opacity: .75; }
  .group { border: 1px solid currentColor; border-radius: 999px; padding: 0 8px; }
  .ctx { margin: 8px 0; }
  .ctx .label { font-size: 12px; opacity: .7; }
  .ctx .body { white-space: pre-wrap; word-break: break-word; }
  .ctx .body.quoted, .ctx .body.parent { border-left: 3px solid rgba(127,127,127,.5); padding-left: 8px; opacity: .9; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  td, th { border-top: 1px solid rgba(127,127,127,.3); padding: 6px 4px; vertical-align: top; text-align: left; }
  th { font-size: 12px; opacity: .7; }
  td.rule { width: 34%; }
  td.choices { width: 26%; white-space: nowrap; }
  td.reason input { width: 100%; box-sizing: border-box; }
  .kind { font-size: 11px; opacity: .7; }
  .hint { font-size: 12px; opacity: .8; margin-top: 2px; }
  tr.changed td.choices { background: rgba(217,119,6,.15); }
  .bar { position: fixed; inset: auto 0 0 0; display: flex; gap: 12px; align-items: center; padding: 12px 16px; background: Canvas; border-top: 1px solid rgba(127,127,127,.4); }
  button { font: inherit; padding: 8px 14px; }
</style>
</head>
<body>
<header>
  <h1>本地人工盲审（预览）</h1>
  <p class="warn" id="suggest-note" hidden></p>
  <p class="warn">本页仅显示帖子状态、规则规格与盲审分组，不含机器标签、生产隐藏动作或任何评分。每个样本对每条规则分别标注；填写后点击“下载标注 JSON”。本页不会自动上传，也不会自动宣称人工确认。</p>
</header>
<section id="rulebook">
  <h2>规则规格（必要上下文）</h2>
</section>
<main id="items"></main>
<div class="bar">
  <button id="download">下载标注 JSON</button>
  <span id="status"></span>
</div>
<script id="blind-data" type="application/json">${embedJson(data)}</script>
<script>
  const data = JSON.parse(document.getElementById('blind-data').textContent);
  const states = data.states;
  const picked = new Map();
  const suggested = data.suggested || {};
  if (data.pairs && !data.suggestionModel) {
    const note = document.getElementById('suggest-note');
    note.hidden = false;
    note.textContent = '独立复核：这里没有任何预选或模型意见，请只凭规则定义与帖子内容判断。每条都必须自己选。';
  }
  if (data.suggestionModel) {
    const note = document.getElementById('suggest-note');
    note.hidden = false;
    note.textContent = '已按模型（' + data.suggestionModel + '）的分析预选了推荐默认值，橙色底表示你改动了推荐。推荐来自模型，不是人工判断：请逐条核对后再下载，未改动的条目会被记为“采纳推荐”。';
  }
  const text = (node, value) => { node.textContent = value; return node; };

  const rulebook = document.getElementById('rulebook');
  for (const rule of data.rules) {
    const box = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = rule.label + ' — ' + rule.id + ' (' + rule.kind + ')';
    box.append(summary);
    const list = document.createElement('dl');
    for (const note of rule.notes) {
      const dt = document.createElement('dt');
      dt.textContent = note.key;
      const dd = document.createElement('dd');
      dd.textContent = note.value;
      list.append(dt, dd);
    }
    box.append(list);
    rulebook.append(box);
  }

  const main = document.getElementById('items');
  const status = document.getElementById('status');
  const pairsOf = (item) => (data.pairs ? data.pairs[item.sampleId] || [] : data.rules.map((rule) => rule.id));
  const total = data.items.reduce((sum, item) => sum + pairsOf(item).length, 0);
  const updateStatus = () => {
    let done = 0;
    let changed = 0;
    for (const value of picked.values()) {
      if (!value || !value.state) continue;
      done += 1;
      if (value.suggested && value.suggested !== value.state) changed += 1;
    }
    status.textContent = '已选 ' + done + ' / ' + total + (data.suggestionModel ? '（其中你改动了推荐 ' + changed + ' 条）' : '');
  };

  const contextBlock = (labelText, value, cls) => {
    const wrap = document.createElement('div');
    wrap.className = 'ctx';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = labelText;
    const body = document.createElement('div');
    body.className = 'body' + (cls ? ' ' + cls : '');
    body.textContent = value;
    wrap.append(label, body);
    return wrap;
  };

  for (const item of data.items) {
    const section = document.createElement('section');
    section.className = 'item';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const id = document.createElement('code');
    id.textContent = item.sampleId;
    const group = document.createElement('span');
    group.className = 'group';
    group.textContent = item.group;
    meta.append(id, group);
    section.append(meta);

    const author = item.author || {};
    section.append(contextBlock('author', (author.handle || '') + (author.name ? ' (' + author.name + ')' : '') || '（未记录）'));
    const zh = (data.translations || {})[item.sampleId] || null;
    // With a translation the Chinese text leads and the original stays one click away.
    const withOriginal = (labelText, original, translated, cls) => {
      if (!translated) return contextBlock(labelText, original, cls);
      const wrap = contextBlock(labelText + '（译文）', translated, cls);
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = '原文';
      const body = document.createElement('div');
      body.className = 'body' + (cls ? ' ' + cls : '');
      body.textContent = original;
      details.append(summary, body);
      wrap.append(details);
      return wrap;
    };
    section.append(withOriginal('text', item.text, zh && zh.text, ''));
    if (item.quoted) section.append(withOriginal('quoted', item.quoted, zh && zh.quoted, 'quoted'));
    if (item.replyingTo) {
      section.append(contextBlock('replyingTo.author', item.replyingTo.author || '（未记录）', 'parent'));
      section.append(withOriginal('replyingTo.text', item.replyingTo.text, zh && zh.parentText, 'parent'));
    }

    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const heading of ['规则', '判断', '理由']) {
      const th = document.createElement('th');
      th.textContent = heading;
      head.append(th);
    }
    table.append(head);
    for (const rule of data.rules) {
      if (!pairsOf(item).includes(rule.id)) continue;
      const key = item.sampleId + '\\u0000' + rule.id;
      const tr = document.createElement('tr');
      const suggestion = (suggested[item.sampleId] || {})[rule.id] || null;

      const ruleCell = document.createElement('td');
      ruleCell.className = 'rule';
      ruleCell.append(text(document.createElement('div'), rule.label));
      ruleCell.append(text(document.createElement('code'), rule.id));
      const kind = document.createElement('div');
      kind.className = 'kind';
      kind.textContent = rule.kind;
      ruleCell.append(kind);
      tr.append(ruleCell);

      const choiceCell = document.createElement('td');
      choiceCell.className = 'choices';
      for (const state of states) {
        const option = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 's-' + item.sampleId + '-r-' + rule.id;
        input.value = state;
        input.addEventListener('change', () => {
          const previous = picked.get(key) || { reason: '' };
          picked.set(key, { state, reason: previous.reason, sampleId: item.sampleId, ruleId: rule.id, group: item.group, suggested: suggestion ? suggestion.state : '' });
          tr.classList.toggle('changed', !!suggestion && suggestion.state !== state);
          updateStatus();
        });
        if (suggestion && suggestion.state === state) {
          input.checked = true;
          picked.set(key, { state, reason: '', sampleId: item.sampleId, ruleId: rule.id, group: item.group, suggested: suggestion.state });
        }
        option.append(input, document.createTextNode(' ' + state));
        choiceCell.append(option);
      }
      if (suggestion) {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = '推荐：' + suggestion.state + (suggestion.reason ? ' — ' + suggestion.reason : '');
        choiceCell.append(hint);
      }
      tr.append(choiceCell);

      const reasonCell = document.createElement('td');
      reasonCell.className = 'reason';
      const reason = document.createElement('input');
      reason.type = 'text';
      reason.placeholder = '理由（可选）';
      reason.addEventListener('input', () => {
        const current = picked.get(key) || { state: '', sampleId: item.sampleId, ruleId: rule.id, group: item.group };
        current.reason = reason.value;
        picked.set(key, current);
      });
      reasonCell.append(reason);
      tr.append(reasonCell);

      table.append(tr);
    }
    section.append(table);
    main.append(section);
  }
  updateStatus();

  document.getElementById('download').addEventListener('click', () => {
    const annotations = [];
    for (const value of picked.values()) {
      if (!value || !value.state) continue;
      annotations.push({
        sampleId: value.sampleId,
        ruleId: value.ruleId,
        group: value.group,
        state: value.state,
        reason: value.reason || '',
        ...(value.suggested ? { suggested: value.suggested, changed: value.suggested !== value.state } : {}),
      });
    }
    const payload = {
      version: 2,
      kind: 'blind-annotations',
      generatedAt: data.generatedAt,
      note: 'Self-reported in the local blind UI; not verified and not human-confirmed until separately applied and reviewed.',
      states: states,
      rules: data.rules.map((rule) => ({ id: rule.id, label: rule.label })),
      annotations: annotations,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2) + '\\n'], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = data.pairs ? 'blind-annotations-independent.json' : 'blind-annotations.json';
    link.click();
    URL.revokeObjectURL(link.href);
  });
</script>
</body>
</html>
`;
}

/** Build the shareable empty annotation template (one row per sample+rule). */
export function buildTemplate(entries, rules, generatedAt) {
  const annotations = [];
  for (const entry of entries) {
    for (const rule of rules) {
      annotations.push({ sampleId: entry.sampleId, ruleId: rule.id, group: entry.group, state: '', reason: '' });
    }
  }
  return {
    version: 2,
    kind: 'blind-annotations',
    generatedAt,
    note: 'Preview template only. One row per sample and rule. Fill state (match/no-match/undecided) and reason, then run `apply`. Not human-confirmed.',
    states: STATES,
    rules: rules.map((rule) => ({ id: rule.id, label: rule.label })),
    annotations,
  };
}

/**
 * Validate a submission against the blind set, the rule set and any existing
 * store. Duplicate sample+rule keys, unknown samples, unknown rules, bad states
 * and already-reviewed keys are rejected instead of applied.
 */
export function validateSubmission(submission, { blindSampleIds, ruleIds, existingKeys, groupBySample = new Map(), allowRereview = false }) {
  const accepted = [];
  const rejected = [];
  if (!submission || typeof submission !== 'object' || !Array.isArray(submission.annotations)) {
    return { accepted, rejected: [{ sampleId: '', ruleId: '', reason: 'bad-submission' }] };
  }
  const inSubmission = new Set();
  const reject = (sampleId, ruleId, reason) => rejected.push({ sampleId, ruleId, reason });
  for (const raw of submission.annotations) {
    const sampleId = raw && raw.sampleId;
    const ruleId = raw && raw.ruleId;
    const state = raw && raw.state;
    const reason = raw && typeof raw.reason === 'string' ? raw.reason : '';
    if (!isPlainId(sampleId) || !isPlainId(ruleId)) {
      reject(String(sampleId ?? ''), String(ruleId ?? ''), 'bad-id');
      continue;
    }
    if (!blindSampleIds.has(sampleId)) {
      reject(sampleId, ruleId, 'unknown-sample');
      continue;
    }
    const expectedGroup = groupBySample.get(sampleId);
    if (expectedGroup && raw.group !== undefined && raw.group !== expectedGroup) {
      reject(sampleId, ruleId, 'group-mismatch');
      continue;
    }
    if (!ruleIds.has(ruleId)) {
      reject(sampleId, ruleId, 'unknown-rule');
      continue;
    }
    const key = recordKey(sampleId, ruleId);
    if (inSubmission.has(key)) {
      reject(sampleId, ruleId, 'duplicate-in-submission');
      continue;
    }
    if (typeof state !== 'string' || state === '') {
      reject(sampleId, ruleId, 'empty-state');
      continue;
    }
    if (!STATES.includes(state)) {
      reject(sampleId, ruleId, 'bad-state');
      continue;
    }
    if (existingKeys.has(key) && !allowRereview) {
      reject(sampleId, ruleId, 'already-reviewed');
      continue;
    }
    inSubmission.add(key);
    accepted.push({
      sampleId,
      ruleId,
      group: expectedGroup ?? (typeof raw.group === 'string' ? raw.group : ''),
      state,
      reason: reason.slice(0, 2000),
      ...(STATES.includes(raw.suggested) ? { suggestedState: raw.suggested } : {}),
    });
  }
  return { accepted, rejected };
}

/** Flatten the nested store into a set of reviewed sample+rule keys. */
export function storeKeys(store) {
  const keys = new Set();
  const records = store && store.version === STORE_VERSION && store.records && typeof store.records === 'object'
    ? store.records
    : {};
  for (const [sampleId, byRule] of Object.entries(records)) {
    if (!byRule || typeof byRule !== 'object') continue;
    for (const ruleId of Object.keys(byRule)) keys.add(recordKey(sampleId, ruleId));
  }
  return keys;
}

/** Merge accepted labels into the nested store without overwriting existing ones. */
export function mergeReviews(store, accepted, { now = new Date().toISOString() } = {}) {
  const baseRecords = store && store.version === STORE_VERSION && store.records && typeof store.records === 'object'
    ? store.records
    : {};
  const records = {};
  for (const [sampleId, byRule] of Object.entries(baseRecords)) records[sampleId] = { ...byRule };
  for (const entry of accepted) {
    const byRule = records[entry.sampleId] || (records[entry.sampleId] = {});
    const previous = byRule[entry.ruleId];
    byRule[entry.ruleId] = {
      state: entry.state,
      reason: entry.reason || '',
      // Set only when the reviewer saw a model-suggested default; lets the report
      // separate independent labels from suggestion-assisted ones.
      ...(entry.suggestedState ? { suggestedState: entry.suggestedState } : {}),
      reviewedAt: now,
      ...(previous ? { previousState: previous.state } : {}),
    };
  }
  return {
    version: STORE_VERSION,
    kind: 'blind-human-labels',
    note: 'Self-reported human labels from the local blind review, one record per sample and rule. Not automatically verified ground truth.',
    updatedAt: now,
    records,
  };
}

async function readJsonFile(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readSampleFiles(dir) {
  const names = (await readdir(dir)).filter((name) => SAMPLE_RE.test(name)).sort();
  const files = [];
  for (const name of names) files.push({ name, content: await readFile(path.join(dir, name), 'utf8') });
  return files;
}

function parseArgs(argv) {
  const args = {
    command: argv[0] || 'prepare',
    dir: path.resolve('tmp/evaluation-samples'),
    rules: path.resolve('docs/filter-rules.md'),
    allowRereview: false,
    suggestions: null,
    assist: null,
    pairs: null,
    htmlName: HTML_NAME,
    submission: null,
  };
  const positional = [];
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dir') args.dir = path.resolve(argv[++i]);
    else if (token === '--rules') args.rules = path.resolve(argv[++i]);
    else if (token === '--assist') args.assist = argv[++i];
    else if (token === '--pairs') args.pairs = argv[++i];
    else if (token === '--html-name') args.htmlName = argv[++i];
    else if (token === '--suggestions') args.suggestions = argv[++i];
    else if (token === '--allow-rereview') args.allowRereview = true;
    else positional.push(token);
  }
  if (positional[0]) args.submission = positional[0];
  return args;
}

async function commandPrepare(args) {
  const queue = loadQueue(await readJsonFile(path.join(args.dir, QUEUE_NAME)));
  const rules = parseRuleSpec(await readFile(args.rules, 'utf8'));
  const { index, unknownKeys } = indexSamples(await readSampleFiles(args.dir));
  const { entries, missing } = selectBlindEntries(queue, index);
  const generatedAt = new Date().toISOString();
  let suggestions = null;
  if (args.suggestions) suggestions = await readJsonFile(path.resolve(args.suggestions));
  await mkdir(args.dir, { recursive: true });
  let translations = null;
  if (args.assist) {
    // Translation plus recommended defaults produced by a model; provenance is kept per label.
    const assist = await readJsonFile(path.resolve(args.assist));
    translations = {};
    const records = {};
    for (const [sampleId, value] of Object.entries(assist.records ?? {})) {
      translations[sampleId] = value.zh;
      records[sampleId] = value.labels;
    }
    suggestions = { model: assist.model, records };
  }
  let pairs = null;
  if (args.pairs) pairs = (await readJsonFile(path.resolve(args.pairs))).pairs;
  await writeFile(path.join(args.dir, args.htmlName), renderHtml(entries, { rules, generatedAt, suggestions, pairs, translations }), { mode: 0o600 });
  // A pair-restricted page never overwrites the full annotation template.
  if (!pairs) await writeFile(path.join(args.dir, TEMPLATE_NAME), JSON.stringify(buildTemplate(entries, rules, generatedAt), null, 2) + '\n', { mode: 0o600 });
  // Counts only: never echo sample text.
  console.log(JSON.stringify({
    command: 'prepare',
    entries: entries.length,
    holdout: entries.filter((entry) => entry.group === GROUPS.holdout).length,
    diagnostic: entries.filter((entry) => entry.group === GROUPS.diagnostic).length,
    rules: rules.length,
    ruleIds: rules.map((rule) => rule.id),
    totalPairs: entries.length * rules.length,
    withQuoted: entries.filter((entry) => entry.quoted).length,
    suggested: suggestions ? Object.keys(suggestions.records ?? {}).length : 0,
    withParent: entries.filter((entry) => entry.replyingTo).length,
    missingSamples: missing.length,
    unexpectedStateKeys: unknownKeys,
    html: args.htmlName,
    pairs: pairs ? pairs.length : null,
    template: TEMPLATE_NAME,
    store: STORE_NAME,
    note: 'Preview + downloadable annotation JSON only; no human confirmation is recorded.',
  }));
}

async function commandApply(args) {
  if (!args.submission) throw new Error('apply needs a submission JSON path');
  const queue = loadQueue(await readJsonFile(path.join(args.dir, QUEUE_NAME)));
  const rules = parseRuleSpec(await readFile(args.rules, 'utf8'));
  const ruleIds = new Set(rules.map((rule) => rule.id));
  const groupBySample = new Map([
    ...queue.diagnosticIds.map((id) => [id, GROUPS.diagnostic]),
    ...queue.holdoutIds.map((id) => [id, GROUPS.holdout]),
  ]);
  const blindSampleIds = new Set(groupBySample.keys());
  let store = null;
  try {
    store = await readJsonFile(path.join(args.dir, STORE_NAME));
  } catch {
    store = null;
  }
  if (store && store.version !== STORE_VERSION && store.records && Object.keys(store.records).length > 0) {
    throw new Error(`the existing store is version ${store.version}; refusing to overwrite it`);
  }
  const existingKeys = storeKeys(store);
  const submission = await readJsonFile(args.submission);
  const { accepted, rejected } = validateSubmission(submission, { blindSampleIds, groupBySample, ruleIds, existingKeys, allowRereview: args.allowRereview });
  const merged = mergeReviews(store, accepted);
  await writeFile(path.join(args.dir, STORE_NAME), JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({
    command: 'apply',
    accepted: accepted.length,
    rejected: rejected.length,
    rejectReasons: rejected.reduce((acc, item) => {
      acc[item.reason] = (acc[item.reason] || 0) + 1;
      return acc;
    }, {}),
    storeRecords: existingKeys.size + accepted.length,
    store: STORE_NAME,
    note: 'Applied as self-reported labels; not independently verified.',
  }));
}

async function commandVerify(args) {
  let store = null;
  try {
    store = await readJsonFile(path.join(args.dir, STORE_NAME));
  } catch {
    store = null;
  }
  const byState = {};
  const byRule = {};
  let total = 0;
  const records = store && store.version === STORE_VERSION && store.records ? store.records : {};
  for (const [sampleId, byRuleMap] of Object.entries(records)) {
    for (const [ruleId, value] of Object.entries(byRuleMap)) {
      total += 1;
      byState[value.state] = (byState[value.state] || 0) + 1;
      byRule[ruleId] = (byRule[ruleId] || 0) + 1;
      void sampleId;
    }
  }
  console.log(JSON.stringify({ command: 'verify', storeRecords: total, byState, byRule, store: STORE_NAME }));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command === 'prepare') return commandPrepare(args);
  if (args.command === 'apply') return commandApply(args);
  if (args.command === 'verify') return commandVerify(args);
  throw new Error(`unknown command: ${args.command}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error('Blind review failed:', error.message);
    process.exitCode = 1;
  });
}