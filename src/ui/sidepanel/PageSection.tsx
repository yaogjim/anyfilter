import { useEffect, useRef, useState } from 'react';
import { ARTICLE_TEXT_CAP_UNITS } from '../../domain/article';
import type { JudgePageError, JudgedPage } from '../../domain/article-judgement';
import {
  ARTICLE_RULES,
  thresholdOf,
  type ArticleRuleId,
  type ArticleVerdict,
  type NotArticleReason,
  type RuleOutcome,
  type Undetermined,
} from '../../domain/article-rules';
import { useLanguage, type Translate } from '../language';
import type { TranslationKey } from '../i18n';
import type { ActiveTab, PageGateway } from './PanelGateway';
import { useSubscribedValue } from './use-subscribed-value';

const RULE_LABEL: Record<ArticleRuleId, TranslationKey> = {
  marketing: 'page.rule.marketing',
  clickbait: 'page.rule.clickbait',
};

const NOT_ARTICLE_TEXT: Record<NotArticleReason, TranslationKey> = {
  blocked: 'page.notArticle.blocked',
  'too-short': 'page.notArticle.tooShort',
  'root-page': 'page.notArticle.rootPage',
  'login-page': 'page.notArticle.loginPage',
  'x-page': 'page.notArticle.xPage',
  model: 'page.notArticle.model',
};

const UNDETERMINED_TEXT: Record<Undetermined, TranslationKey> = {
  truncated: 'page.reason.truncated',
  paywall: 'page.reason.paywall',
  'no-answer': 'page.reason.noAnswer',
};

function errorText(error: JudgePageError, detail: string, t: Translate): string {
  switch (error) {
    case 'no-access':
      return t('page.error.noAccess');
    case 'extract-failed':
      return t('page.error.extractFailed');
    case 'no-key':
      return t('page.error.noKey');
    case 'rate-limited':
      return t('page.error.rateLimited');
    case 'auth':
      return t('page.error.auth');
    case 'network':
      return t('page.error.network', { detail });
    case 'bad-response':
      return t('page.error.badResponse', { detail });
  }
}

/** Whether the tab in front can be read at all, known before anyone presses. The
 * browser hides a tab's address until `activeTab` is granted, so a missing
 * address means the toolbar icon has not been clicked on it. */
type Readiness = 'loading' | 'ready' | 'needs-icon' | 'unreadable' | 'x-page';

function readinessOf(tab: ActiveTab | null, loaded: boolean): Readiness {
  if (!loaded) return 'loading';
  if (tab === null || tab.id === null || tab.url === null || tab.url === '') return 'needs-icon';
  if (!/^https?:\/\//.test(tab.url)) return 'unreadable';
  if (/^https?:\/\/([^/]+\.)?(x|twitter)\.com(\/|$)/i.test(tab.url)) return 'x-page';
  return 'ready';
}

const READINESS_HINT: Record<Exclude<Readiness, 'loading' | 'ready'>, TranslationKey> = {
  'needs-icon': 'page.hint.needsIcon',
  unreadable: 'page.hint.unreadable',
  'x-page': 'page.hint.xPage',
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'judging' }
  | { kind: 'done'; page: JudgedPage; verdict: ArticleVerdict }
  | { kind: 'error'; error: JudgePageError; detail: string };

const percent = (probability: number): number => Math.round(probability * 100);

function Details({ outcomes }: { outcomes: RuleOutcome[] }) {
  const { t } = useLanguage();
  return (
    <details className="mt-2 text-xs text-ink-2">
      <summary className="cursor-pointer font-semibold">{t('page.details')}</summary>
      <ul className="mb-0 mt-1.5 list-none space-y-1 p-0">
        {outcomes.map((outcome) => {
          const rule = ARTICLE_RULES.find((candidate) => candidate.id === outcome.rule);
          const label = t(RULE_LABEL[outcome.rule]);
          return (
            <li key={outcome.rule} data-anyfilter-page-rule={outcome.rule} data-anyfilter-page-status={outcome.status}>
              {outcome.probability === undefined || rule === undefined
                ? t('page.detail.unscored', { label })
                : t('page.detail.scored', {
                    label,
                    probability: percent(outcome.probability),
                    threshold: percent(thresholdOf(rule)),
                  })}
              {outcome.status === 'undetermined' && ` · ${t(UNDETERMINED_TEXT[outcome.reason])}`}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function Verdict({ verdict }: { verdict: ArticleVerdict }) {
  const { t } = useLanguage();
  if (verdict.kind === 'not-article') {
    return (
      <div data-anyfilter-page-verdict="not-article">
        <p className="m-0 text-[13px] font-bold">{t('page.notArticle.title')}</p>
        <p className="mb-0 mt-1 text-xs text-ink-2">{t(NOT_ARTICLE_TEXT[verdict.reason])}</p>
      </div>
    );
  }
  const { top } = verdict;
  const rule = top === null ? undefined : ARTICLE_RULES.find((candidate) => candidate.id === top.rule);
  const others = verdict.outcomes.filter((outcome) => outcome.status === 'match' && outcome.rule !== top?.rule);
  const undetermined = verdict.outcomes.filter(
    (outcome): outcome is Extract<RuleOutcome, { status: 'undetermined' }> => outcome.status === 'undetermined',
  );
  return (
    <div data-anyfilter-page-verdict={top === null ? 'clean' : 'match'}>
      {top !== null && rule !== undefined ? (
        <p className="m-0 text-[13px] font-bold text-hide">
          {t('page.match', {
            label: t(RULE_LABEL[top.rule]),
            probability: percent(top.probability),
            threshold: percent(thresholdOf(rule)),
          })}
        </p>
      ) : (
        <p className="m-0 text-[13px] font-bold">{t('page.clean')}</p>
      )}
      {others.length > 0 && (
        <p className="mb-0 mt-1 text-xs text-ink-2">
          {t('page.othersMatched', { labels: others.map((outcome) => t(RULE_LABEL[outcome.rule])).join(', ') })}
        </p>
      )}
      {/* Not deciding is not the same as clearing: it is said in words, per rule. */}
      {undetermined.map((outcome) => (
        <p key={outcome.rule} className="mb-0 mt-1 text-xs text-ink-2">
          {t('page.undetermined', {
            label: t(RULE_LABEL[outcome.rule]),
            reason: t(UNDETERMINED_TEXT[outcome.reason]),
          })}
        </p>
      ))}
      {verdict.truncated && (
        <p className="mb-0 mt-1 text-xs text-ink-2">{t('page.truncatedNote', { count: ARTICLE_TEXT_CAP_UNITS })}</p>
      )}
      <Details outcomes={verdict.outcomes} />
    </div>
  );
}

export function PageSection({ gateway }: { gateway: PageGateway }) {
  const { t } = useLanguage();
  const activeTab = useSubscribedValue(gateway.loadActiveTab, gateway.onActiveTabChanged);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const tabId = activeTab.status === 'ready' ? activeTab.value.id : null;
  const tabUrl = activeTab.status === 'ready' ? activeTab.value.url : null;
  const readiness = readinessOf(activeTab.status === 'ready' ? activeTab.value : null, activeTab.status === 'ready');
  // Which page is in front right now, so a slow answer for a page the person has
  // since left is dropped instead of being shown against the wrong page.
  const current = useRef('');
  current.current = `${tabId}|${tabUrl}`;

  // A result belongs to the page it was made for. Another tab, or another page
  // in this tab, starts from a blank slate instead of showing an old verdict.
  useEffect(() => {
    setPhase({ kind: 'idle' });
  }, [tabId, tabUrl]);

  const judge = (): void => {
    if (tabId === null) {
      setPhase({ kind: 'error', error: 'no-access', detail: '' });
      return;
    }
    const requestedFor = current.current;
    setPhase({ kind: 'judging' });
    void gateway.judgePage(tabId).then((result) => {
      if (current.current !== requestedFor) return;
      setPhase(
        result.ok
          ? { kind: 'done', page: result.page, verdict: result.verdict }
          : { kind: 'error', error: result.error, detail: result.detail },
      );
    });
  };

  return (
    <section className="rounded-xl border border-line bg-white p-3.5" aria-label={t('page.heading')} data-anyfilter-page="section">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-[13px] font-bold">{t('page.heading')}</h2>
        <button
          type="button"
          data-anyfilter-page="judge"
          disabled={phase.kind === 'judging' || readiness !== 'ready'}
          onClick={judge}
          className="min-h-9 rounded-lg border border-ink bg-ink px-2.5 py-1.5 text-[12px] font-semibold text-white transition disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          {phase.kind === 'judging' ? t('page.judging') : t('page.judge')}
        </button>
      </div>
      <p className="mb-0 mt-2 text-xs text-ink-2">{t('page.intro', { count: ARTICLE_TEXT_CAP_UNITS })}</p>
      {readiness !== 'ready' && readiness !== 'loading' && (
        <p data-anyfilter-page-hint={readiness} className="mb-0 mt-3 text-xs text-ink">
          {t(READINESS_HINT[readiness])}
        </p>
      )}
      {phase.kind === 'error' && (
        <p role="alert" data-anyfilter-page-error={phase.error} className="mb-0 mt-3 text-xs text-hide">
          {errorText(phase.error, phase.detail, t)}
        </p>
      )}
      {phase.kind === 'done' && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="mb-2 mt-0 truncate text-xs text-ink-2" title={phase.page.url}>
            {t('page.judgedPage', {
              title: phase.page.title === '' ? t('page.untitled') : phase.page.title,
              units: phase.page.units,
            })}
          </p>
          <Verdict verdict={phase.verdict} />
          <p className="mb-0 mt-3 text-[11px] text-ink-2">{t('page.disclaimer')}</p>
        </div>
      )}
    </section>
  );
}
