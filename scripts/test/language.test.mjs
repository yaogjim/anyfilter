import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { settingsEn } from '../../src/ui/locales/settings.en.ts';
import { settingsZh } from '../../src/ui/locales/settings.zh-CN.ts';
import { verificationEn } from '../../src/ui/locales/verification.en.ts';
import { verificationZh } from '../../src/ui/locales/verification.zh-CN.ts';
import { shellEn } from '../../src/ui/locales/shell.en.ts';
import { shellZh } from '../../src/ui/locales/shell.zh-CN.ts';
import { evaluationEn } from '../../src/ui/locales/evaluation.en.ts';
import { evaluationZh } from '../../src/ui/locales/evaluation.zh-CN.ts';
import { reviewEn } from '../../src/ui/locales/review.en.ts';
import { reviewZh } from '../../src/ui/locales/review.zh-CN.ts';

const en = { ...settingsEn, ...verificationEn, ...shellEn, ...reviewEn, ...evaluationEn };
const zh = { ...settingsZh, ...verificationZh, ...shellZh, ...reviewZh, ...evaluationZh };
const placeholders = (text) => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((match) => match[1]).sort();

// Resource parity protects against a key or interpolated value disappearing in
// one locale. The TypeScript TranslationKey type checks component references.
test('the English and Chinese catalogs have matching keys and placeholders', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key);
    assert.ok(en[key].trim() && zh[key].trim(), `${key} must not be empty`);
  }
});

const root = path.resolve(import.meta.dirname, '../../src');
const files = [
  'ui/sidepanel/App.tsx', 'ui/sidepanel/Header.tsx', 'ui/sidepanel/HiddenGroups.tsx',
  'ui/sidepanel/HiddenRow.tsx', 'ui/sidepanel/Tiles.tsx', 'ui/sidepanel/ReasonAccordion.tsx',
  'ui/sidepanel/PostCard.tsx', 'ui/sidepanel/SettingsSection.tsx',
  'ui/sidepanel/RuleManager.tsx', 'ui/sidepanel/RuleEditor.tsx',
  'ui/sidepanel/RulePreview.tsx', 'ui/sidepanel/VerificationSection.tsx',
  'ui/sidepanel/CaptureSection.tsx', 'ui/sidepanel/ReviewSwitch.tsx', 'ui/sidepanel/ReviewDataSection.tsx', 'ui/sidepanel/EvaluationSection.tsx',
  'infrastructure/review-panel.ts',
  'infrastructure/review-layer.ts', 'infrastructure/review-toolbar.ts', 'entrypoints/options/main.tsx',
];

test('components refer to identifiers rather than inline bilingual copy', () => {
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && node.expression.text === 't') || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 't'))) {
        assert.ok(node.arguments.length <= 2, `${file}: t() accepts a key and optional parameters`);
        const first = node.arguments[0];
        if (first && ts.isStringLiteral(first)) {
          assert.ok(Object.hasOwn(en, first.text), `${file}: unknown key ${first.text}`);
          const required = placeholders(en[first.text]);
          if (required.length) {
            const params = node.arguments[1];
            assert.ok(params && ts.isObjectLiteralExpression(params), `${file}: ${first.text} needs parameters`);
            const supplied = params.properties
              .filter((property) => ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
              .map((property) => property.name.getText(source));
            for (const name of required) assert.ok(supplied.includes(name), `${file}: ${first.text} lacks {${name}}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});
test('content-script review code carries no inline Chinese copy', () => {
  for (const file of ['infrastructure/review-layer.ts', 'infrastructure/review-toolbar.ts', 'infrastructure/review-panel.ts', 'infrastructure/timeline-view.ts', 'domain/review-view.ts', 'domain/review.ts', 'domain/review-record.ts', 'features/review-annotations.ts']) {
    assert.ok(!/[\u4e00-\u9fff]/.test(readFileSync(path.join(root, file), 'utf8')), `${file} must use catalog keys`);
  }
});
