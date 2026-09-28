import type { ProviderId } from '../domain/provider';
import { hashString } from '../domain/rule';
import { isScores, type Scores } from '../domain/verdict';

/** Bumped by {@link forgetScores}. A request that started before a data clear
 * captures this and refuses to write its answer afterwards, so clearing data can
 * never be undone by a response that was already in flight. */
let epoch = 0;

export function scoresEpoch(): number {
  return epoch;
}

function cacheKey(
  postId: string,
  provider: ProviderId,
  questionsKey: string,
  contentKey: string,
): string {
  return `anyfilter.scores.${provider}.${questionsKey}.${hashString(contentKey)}.${postId}`;
}

export async function cachedScores(
  postId: string,
  provider: ProviderId,
  questionsKey: string,
  contentKey: string,
): Promise<Scores | null> {
  const key = cacheKey(postId, provider, questionsKey, contentKey);
  const stored = await chrome.storage.session.get(key);
  const value: unknown = stored[key];
  return isScores(value) ? value : null;
}

export async function rememberScores(
  postId: string,
  provider: ProviderId,
  questionsKey: string,
  contentKey: string,
  scores: Scores,
): Promise<void> {
  await chrome.storage.session.set({ [cacheKey(postId, provider, questionsKey, contentKey)]: scores });
}

export async function forgetScores(): Promise<void> {
  epoch += 1;
  const stored = await chrome.storage.session.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith('anyfilter.scores.'));
  if (keys.length > 0) await chrome.storage.session.remove(keys);
}