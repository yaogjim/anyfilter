import type { ClassifierPort } from '../domain/classifier-port';
import { isClassifyResult, type ClassifyResult, type RuntimeMessage } from '../domain/messages';
import type { Post, PostKind } from '../domain/post';
import {
  isPreviewResult,
  isSaveRulesResult,
  type PreviewInput,
  type PreviewResult,
  type Rule,
  type SaveRulesResult,
} from '../domain/rule';
import type { Reason } from '../domain/verdict';
import type { VerdictSink } from '../domain/verdict-sink';

async function send(message: RuntimeMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

export class BackgroundClient implements ClassifierPort, VerdictSink {
  async classify(
    post: Post,
    questions: Record<string, string>,
    questionsKey: string,
  ): Promise<ClassifyResult> {
    try {
      const response = await send({ type: 'classify', post, questions, questionsKey });
      return isClassifyResult(response)
        ? response
        : { ok: false, error: 'bad-response', detail: 'malformed response from background' };
    } catch (error) {
      return {
        ok: false,
        error: 'network',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  report(post: Post, reasons: Reason[], tokens: number): void {
    void send({ type: 'report', post, reasons, tokens }).catch(() => undefined);
  }

  async override(postId: string, shown: boolean): Promise<void> {
    await send({ type: 'override', postId, shown });
  }

  async clearData(): Promise<void> {
    await send({ type: 'clear-data' });
  }

  async clearHidden(kind: PostKind): Promise<void> {
    await send({ type: 'clear-hidden', kind });
  }

  async saveRules(rules: Rule[], expectedRevision: number): Promise<SaveRulesResult> {
    try {
      const response = await send({ type: 'save-rules', rules, expectedRevision });
      return isSaveRulesResult(response)
        ? response
        : { ok: false, error: 'invalid', detail: 'malformed response from background' };
    } catch (error) {
      return {
        ok: false,
        error: 'invalid',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async previewRule(input: PreviewInput): Promise<PreviewResult> {
    try {
      const response = await send({ type: 'preview-rule', input });
      return isPreviewResult(response)
        ? response
        : { ok: false, error: 'bad-response', detail: 'malformed response from background' };
    } catch (error) {
      return {
        ok: false,
        error: 'network',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}