import { useEffect, useRef, useState } from 'react';
import {
  validateRules,
  type PreviewInput,
  type PreviewResult,
  type Rule,
  type SaveRulesResult,
} from '../../domain/rule';
import { RulePreview } from './RulePreview';
import { RuleRow } from './RuleEditor';
import { newCustomRule, rulesEqual, withRule, withoutRule } from './rules-draft';

const SUBHEADING_CLASS = 'mb-1.5 mt-4 text-[13px] font-bold text-ink';
const BUTTON_CLASS = 'rounded-lg border border-[#cfd9de] bg-white px-3 py-1.5 font-bold';

type Message = { tone: 'ok' | 'error'; text: string };

export function RuleManager({
  rules,
  revision,
  threshold,
  onSaveRules,
  onPreview,
  onDirtyChange,
}: {
  rules: readonly Rule[];
  revision: number;
  threshold: number;
  onSaveRules: (rules: Rule[], expectedRevision: number) => Promise<SaveRulesResult>;
  onPreview: (input: PreviewInput) => Promise<PreviewResult>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<Rule[]>(() => [...rules]);
  // The revision the draft is based on. It only follows the saved revision while
  // there are no unsaved edits, so a save from another panel can never be
  // silently overwritten: saving a stale base reports a conflict instead.
  const [baseRevision, setBaseRevision] = useState(revision);
  const [openId, setOpenId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // Counts user edits so a save that resolves late never clobbers newer input.
  const editSeq = useRef(0);
  const dirty = !rulesEqual(draft, rules);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Follow rules saved elsewhere while there is nothing unsaved here; keep the
  // draft (and its older base revision) once the user has edits.
  useEffect(() => {
    if (dirty) return;
    setDraft([...rules]);
    setBaseRevision(revision);
  }, [rules, revision, dirty]);

  const patch = (id: string, change: Partial<Rule>): void => {
    editSeq.current += 1;
    setDraft((current) => withRule(current, id, change));
  };

  const addRule = (): void => {
    editSeq.current += 1;
    const rule = newCustomRule(draft);
    setDraft((current) => [...current, rule]);
    setOpenId(rule.id);
    setMessage(null);
  };

  const deleteRule = (id: string): void => {
    editSeq.current += 1;
    setDraft((current) => withoutRule(current, id));
    setOpenId((current) => (current === id ? null : current));
    setMessage(null);
  };

  const save = (): void => {
    const validation = validateRules(draft);
    if (!validation.ok) {
      setMessage({ tone: 'error', text: validation.detail });
      return;
    }
    const submittedSeq = editSeq.current;
    setSaving(true);
    setMessage(null);
    void onSaveRules(validation.rules, baseRevision).then((result) => {
      setSaving(false);
      if (result.ok) {
        setConflict(false);
        // Rebase on the revision we just wrote. If the user kept editing while
        // the save was in flight, their newer draft stays instead of being
        // replaced by the response.
        setBaseRevision(result.settings.revision);
        if (editSeq.current === submittedSeq) {
          setDraft(result.settings.rules);
          setMessage({ tone: 'ok', text: 'Rules saved and applied.' });
        } else {
          setMessage({ tone: 'ok', text: 'Saved. Your newer edits are still unsaved.' });
        }
        return;
      }
      if (result.error === 'conflict') {
        setConflict(true);
        setMessage({
          tone: 'error',
          text: 'Rules changed in another panel since you started editing. Reload to get the latest before saving.',
        });
        return;
      }
      setMessage({ tone: 'error', text: result.detail });
    });
  };

  const cancel = (): void => {
    setDraft([...rules]);
    setBaseRevision(revision);
    setConflict(false);
    setMessage(null);
  };

  const reload = (): void => {
    setDraft([...rules]);
    setBaseRevision(revision);
    setConflict(false);
    setMessage({ tone: 'ok', text: 'Reloaded the latest saved rules.' });
  };

  return (
    <>
      <h3 className={SUBHEADING_CLASS}>What to hide</h3>
      <div className="divide-y divide-line rounded-lg border border-line">
        {draft.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            open={openId === rule.id}
            onToggleOpen={() => setOpenId((current) => (current === rule.id ? null : rule.id))}
            onPatch={(change) => patch(rule.id, change)}
            onDelete={rule.source === 'custom' ? () => deleteRule(rule.id) : null}
          />
        ))}
      </div>
      <p className="mt-1 text-[11px] text-ink-2">
        Every rule is on by default, but they have not all been accuracy-verified. Ads are decided
        by a local page check; the rest are sent to Jev as the text you see in each editor.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button type="button" className={BUTTON_CLASS} onClick={addRule}>
          New rule
        </button>
        <button
          type="button"
          className="rounded-lg bg-ink px-3 py-1.5 font-bold text-white disabled:opacity-40"
          disabled={!dirty || saving}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save and apply'}
        </button>
        <button type="button" className={BUTTON_CLASS} disabled={!dirty || saving} onClick={cancel}>
          Cancel
        </button>
        {dirty && <span className="text-[11px] text-ink-2">Unsaved changes</span>}
      </div>
      <p className="mt-1 text-[11px] text-ink-2">
        Saving re-scores posts affected by a changed rule. Renaming a rule or changing only its
        threshold reuses cached scores. Cancel leaves the saved rules untouched.
      </p>
      {message && (
        <p
          className={`m-0 mt-1.5 rounded-lg px-2.5 py-1.5 text-[12px] ${
            message.tone === 'ok' ? 'bg-surface text-keep' : 'bg-surface text-hide'
          }`}
        >
          {message.text}
          {conflict && (
            <button type="button" className="ml-2 underline" onClick={reload}>
              Reload
            </button>
          )}
        </p>
      )}

      <h3 className={SUBHEADING_CLASS}>Test a text</h3>
      <RulePreview rules={draft} threshold={threshold} onPreview={onPreview} />
    </>
  );
}