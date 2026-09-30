import {
  ARTICLE_TEXT_CAP_UNITS,
  headUnits,
  stripSiteSuffix,
  type ExtractedArticle,
} from './article';
import { checkArticleGate, type GateReason } from './article-gate';
import type { Scores } from './verdict';

/**
 * Article rules, version 1: two rules, each with its own threshold.
 *
 * The marketing question was tried offline against 27 real low-quality pages and
 * 21 more unseen pages (docs/article-rules.md 5.1, 5.2). The clickbait question was
 * replaced after it missed 92% of human-labelled clickbait (5.3).
 * They are kept word for word: a reworded question is a different question, and
 * the thresholds below were chosen for these.
 */
export type ArticleRuleId = 'marketing' | 'clickbait';

export interface ArticleRule {
  id: ArticleRuleId;
  /** The badge says "reads like <label>", never "is". */
  label: string;
  question: string;
  /** Probability at or above which the rule matches. Per rule, never global. */
  threshold: number;
  /** Whether the rule needs the whole text: a truncated page or a paywall preview
   * that does not already match is "undetermined", not "no match". */
  needsFullText: boolean;
}

/** Used by any rule that does not set its own threshold. */
export const DEFAULT_ARTICLE_THRESHOLD = 0.7;

/** Below this the model is fairly sure the page is not readable as one article.
 * Deliberately low: in the trials the question wrongly scored a real weekly
 * digest at 0.29 and a comment thread at 0.48, so 0.5 would refuse real articles.
 * The obvious non-articles are caught by the code gate first. */
export const READABLE_THRESHOLD = 0.2;

const IGNORE =
  ' Ignore ads, sponsored cards, subscription prompts, reference lists, footnotes, revision logs, contributor lists, recommended-article cards and reader comments: they are not the article. A missing author, disclosure of AI use, or writing about AI is not evidence. Judge only how the text reads.';

export const READABLE_QUESTION_ID = 'readable';
const READABLE_QUESTION =
  'Is this page readable as a single article (not a blocked, error, empty or login page, and not a list or feed)?';

export const ARTICLE_RULES: readonly ArticleRule[] = [
  {
    id: 'marketing',
    label: 'marketing',
    // 0.4: sits in the gap between the highest non-marketing page (0.21) and the
    // lowest marketing page (0.45) in two rounds of trials. See article-rules.md 5.2.
    threshold: 0.4,
    needsFullText: false,
    question:
      "Is the page's main purpose to sell a product, service, event or organisation rather than give the reader independent information or analysis (features, prices, offers, calls to action, a company's own promotional blog)? Answer no if: it is a review or hands-on write-up even if about one product; the author mentions their own product or newsletter in passing; the ads or banners are only at the page edge; it is a technical document on how to use a product." +
      IGNORE,
  },
  {
    id: 'clickbait',
    label: 'clickbait',
    // 0.5: on 220 human-labelled headlines (Webis Clickbait 2017) this wording gave
    // 35-40% recall at 92-96% precision, and about 3% of ordinary headlines above it.
    // See article-rules.md 5.3.
    threshold: 0.5,
    // The question is about the title's style, so the rest of the text is not needed.
    needsFullText: false,
    question:
      "Is the title written in a clickbait style: it withholds the key information, teases with a curiosity gap or suspense, exaggerates, or uses an emotional hook or direct address to make the reader click, instead of plainly stating what the article says? Answer no if the title plainly says what the article is about, even if it is attractive, rhetorical or humorous." +
      IGNORE,
  },
];

export function thresholdOf(rule: ArticleRule): number {
  return Number.isFinite(rule.threshold) ? rule.threshold : DEFAULT_ARTICLE_THRESHOLD;
}

/** The questions sent to the model: the two rules plus the readability check. */
export function articleQuestions(rules: readonly ArticleRule[] = ARTICLE_RULES): Record<string, string> {
  const questions: Record<string, string> = { [READABLE_QUESTION_ID]: READABLE_QUESTION };
  for (const rule of rules) questions[rule.id] = rule.question;
  return questions;
}

/** Whether only the beginning of the page is judged. */
export function isTruncated(article: ExtractedArticle): boolean {
  return article.units > ARTICLE_TEXT_CAP_UNITS;
}

/** The page state sent to the model, in the shape the offline trials used. */
export function articleState(article: ExtractedArticle): Record<string, unknown> {
  return {
    title: stripSiteSuffix(article.title),
    author: article.author,
    site: article.site,
    published: article.published,
    description: article.description,
    language: article.language,
    headings: article.headings.slice(0, 12),
    text: headUnits(article.text, ARTICLE_TEXT_CAP_UNITS),
    word_count: article.units,
    truncated: isTruncated(article),
    paywall_detected: article.paywallDetected,
  };
}

export type Undetermined = 'truncated' | 'paywall' | 'no-answer';

export type RuleOutcome =
  | { rule: ArticleRuleId; status: 'match'; probability: number }
  | { rule: ArticleRuleId; status: 'no-match'; probability: number }
  /** Not the same as "no match": the answer depends on text that was not seen. */
  | { rule: ArticleRuleId; status: 'undetermined'; reason: Undetermined; probability?: number };

export type NotArticleReason = GateReason | 'model';

export type ArticleVerdict =
  | { kind: 'not-article'; reason: NotArticleReason }
  | {
      kind: 'judged';
      truncated: boolean;
      paywall: boolean;
      outcomes: RuleOutcome[];
      /** The matched rule with the highest probability, or null. Only this one is
       * shown on the badge; the rest are available on demand. */
      top: Extract<RuleOutcome, { status: 'match' }> | null;
    };

/** Whether the code gate alone refuses the page, before any model is asked. */
export function gateBeforeModel(article: ExtractedArticle): GateReason | null {
  const gate = checkArticleGate(article);
  return gate.ok ? null : gate.reason;
}

/**
 * Turns the model's answers into a verdict. A missing or out-of-range answer is
 * "undetermined", never a zero: the caller must not read silence as "no match".
 */
export function judgeArticle(
  article: ExtractedArticle,
  scores: Scores,
  rules: readonly ArticleRule[] = ARTICLE_RULES,
): ArticleVerdict {
  const early = gateBeforeModel(article);
  if (early !== null) return { kind: 'not-article', reason: early };

  const readable = scores[READABLE_QUESTION_ID];
  if (isProbability(readable) && readable < READABLE_THRESHOLD) {
    return { kind: 'not-article', reason: 'model' };
  }

  const truncated = isTruncated(article);
  const paywall = article.paywallDetected;
  const outcomes: RuleOutcome[] = rules.map((rule): RuleOutcome => {
    const probability = scores[rule.id];
    if (!isProbability(probability)) {
      return { rule: rule.id, status: 'undetermined', reason: 'no-answer' };
    }
    if (probability >= thresholdOf(rule)) return { rule: rule.id, status: 'match', probability };
    if (rule.needsFullText && (truncated || paywall)) {
      return {
        rule: rule.id,
        status: 'undetermined',
        reason: paywall ? 'paywall' : 'truncated',
        probability,
      };
    }
    return { rule: rule.id, status: 'no-match', probability };
  });

  let top: Extract<RuleOutcome, { status: 'match' }> | null = null;
  for (const outcome of outcomes) {
    if (outcome.status === 'match' && (top === null || outcome.probability > top.probability)) {
      top = outcome;
    }
  }
  return { kind: 'judged', truncated, paywall, outcomes, top };
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
