import type { ParentPost, Post } from '../domain/post';
import { hashString } from '../domain/rule';
import type { TimelineView as TimelineViewPort } from '../domain/timeline-view';
import {
  readOwnHandle,
  readParentPost,
  readPost,
  readPostId,
  threadHeadOf,
  type ReadContext,
} from './timeline-reader';

const PROCESSED_ATTRIBUTE = 'data-anyfilter';
const SIGNATURE_ATTRIBUTE = 'data-anyfilter-sig';
const POST_ID_ATTRIBUTE = 'data-anyfilter-id';
const FLASH_CLASS = 'anyfilter-flash';
const SLIDING_CLASS = 'anyfilter-sliding';
const HIDING_CLASS = 'anyfilter-hiding';
const HIDDEN_CLASS = 'anyfilter-hidden';
const FLASH_MS = 450;
const SLIDE_MS = 460;
const COLLAPSE_MS = 220;
const TICK_MS = 40;
const ARTICLE_SELECTOR = 'article[data-testid="tweet"]';

interface PageContext {
  ownHandle: string;
  focal: ParentPost | null;
  focalArticle: Element | null;
}

const HOME_PATH = /^\/home(?:[/?#]|$)/;
const SEARCH_PATH = /^\/search(?:[/?#]|$)/;
const STATUS_PATH = /^\/[A-Za-z0-9_]{1,15}\/status\/\d+(?:[/?#]|$)/;

export function isFilteredPage(pathname: string): boolean {
  return HOME_PATH.test(pathname) || SEARCH_PATH.test(pathname) || STATUS_PATH.test(pathname);
}

/** Content fingerprint of a rendered article. It hashes the actual text rather
 * than its length, so an equal-length rewrite is still noticed, and it folds in
 * the quoted post, the parent context the article will be judged against, media
 * and the "Show more" state. A change in any of these re-emits the post for a
 * fresh judgement instead of being silently skipped. */
function signatureOf(article: Element, parent: ParentPost | null): string {
  const text = article.querySelector('[data-testid="tweetText"]')?.textContent ?? '';
  const quoted =
    article.querySelector('div[role="link"] [data-testid="tweetText"]')?.textContent ?? '';
  const media = article.querySelectorAll('img[src*="pbs.twimg.com/media/"]').length;
  const video = article.querySelector('video, [data-testid="videoPlayer"]') !== null ? 1 : 0;
  const more = article.querySelector('[data-testid="tweet-text-show-more-link"]') !== null ? 1 : 0;
  return [
    hashString(text),
    hashString(quoted),
    hashString(parent?.text ?? ''),
    media,
    video,
    more,
  ].join(':');
}

/** A post whose text, media, quote, or parent has not rendered yet is not ready
 * to be judged; it is revisited on a later scan instead of being marked done. */
function isReadable(post: Post): boolean {
  return (
    post.text !== '' ||
    post.promoted ||
    post.imageUrls.length > 0 ||
    post.hasVideo ||
    post.quotedText !== '' ||
    post.parent !== null
  );
}

export class TimelineView implements TimelineViewPort {
  private readonly focalCache = new Map<string, ParentPost>();
  private readonly avatarByHandle = new Map<string, string>();
  private readonly waitingForView = new Map<HTMLElement, IntersectionObserver>();
  private readonly revealed = new Set<string>();
  /** Articles that were processed before their text rendered. Never marks them
   * as fully handled, so a later scan can pick them up. */
  private readonly pendingText = new WeakSet<HTMLElement>();

  constructor() {
    this.installStyles();
  }

  onChange(listener: () => void): () => void {
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        listener();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }

  scan(questionsKey: string): Post[] {
    const posts: Post[] = [];
    if (!isFilteredPage(location.pathname)) return posts;
    const page = this.pageContext();
    for (const article of document.querySelectorAll<HTMLElement>(ARTICLE_SELECTOR)) {
      const parent = this.parentFor(article, page);
      const signature = signatureOf(article, parent);
      const processed = article.getAttribute(PROCESSED_ATTRIBUTE) === questionsKey;
      const unchanged = article.getAttribute(SIGNATURE_ATTRIBUTE) === signature;
      if (processed && unchanged && !this.pendingText.has(article)) continue;
      const post = this.readArticle(article, page);
      if (!post) continue;
      // Only mark an article once it has been read, so an article whose text has
      // not rendered yet is retried instead of being silently skipped forever.
      article.setAttribute(PROCESSED_ATTRIBUTE, questionsKey);
      article.setAttribute(SIGNATURE_ATTRIBUTE, signature);
      article.setAttribute(POST_ID_ATTRIBUTE, post.id);
      if (isReadable(post)) this.pendingText.delete(article);
      else this.pendingText.add(article);
      posts.push(post);
    }
    return posts;
  }

  read(postId: string): Post | null {
    const article = this.articlesOf(postId)[0];
    return article ? this.readArticle(article, this.pageContext()) : null;
  }

  private readArticle(article: Element, page: PageContext): Post | null {
    const post = readPost(article, this.contextFor(article, page));
    if (!post) return null;
    if (post.avatarUrl) {
      this.avatarByHandle.set(post.handle, post.avatarUrl);
      return post;
    }
    return { ...post, avatarUrl: this.avatarByHandle.get(post.handle) ?? '' };
  }

  unmark(postId: string): void {
    for (const article of this.articlesOf(postId)) {
      article.removeAttribute(PROCESSED_ATTRIBUTE);
      article.removeAttribute(SIGNATURE_ATTRIBUTE);
      this.pendingText.delete(article);
    }
  }

  hide(postId: string, animate: boolean): void {
    for (const target of this.hideTargetsOf(postId)) {
      if (this.waitingForView.has(target) || this.isHiding(target)) continue;
      if (!animate && this.revealed.has(postId)) {
        this.finishHide(target, false);
        continue;
      }
      this.markWhenVisible(target, postId);
    }
  }

  show(postId: string): void {
    for (const target of this.hideTargetsOf(postId)) {
      this.stopWaiting(target);
      target.classList.remove(FLASH_CLASS, SLIDING_CLASS, HIDING_CLASS, HIDDEN_CLASS);
      target.style.maxHeight = '';
      if (target.parentElement) target.parentElement.style.overflow = '';
    }
  }

  private isHiding(target: HTMLElement): boolean {
    return [HIDDEN_CLASS, HIDING_CLASS, SLIDING_CLASS, FLASH_CLASS].some((name) =>
      target.classList.contains(name),
    );
  }

  private markWhenVisible(target: HTMLElement, postId: string): void {
    const inFocus = (entry: IntersectionObserverEntry): boolean => {
      if (!entry.isIntersecting) return false;
      const top = entry.boundingClientRect.top;
      const viewport = entry.rootBounds?.height ?? window.innerHeight;
      return entry.intersectionRatio >= 0.5 || (top >= 0 && top <= viewport * 0.75);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some(inFocus)) return;
        this.stopWaiting(target);
        this.flashThenCollapse(target, postId);
      },
      { rootMargin: '0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    observer.observe(target);
    this.waitingForView.set(target, observer);
  }

  private flashThenCollapse(target: HTMLElement, postId: string): void {
    target.classList.add(FLASH_CLASS);
    const flashedAt = Date.now();
    const tick = (): void => {
      if (!target.isConnected || !target.classList.contains(FLASH_CLASS)) return;
      if (Date.now() - flashedAt >= FLASH_MS) {
        this.revealed.add(postId);
        this.finishHide(target, true);
        return;
      }
      setTimeout(tick, TICK_MS);
    };
    setTimeout(tick, FLASH_MS);
  }

  private stopWaiting(target: HTMLElement): void {
    this.waitingForView.get(target)?.disconnect();
    this.waitingForView.delete(target);
  }

  private pageContext(): PageContext {
    const ownHandle = readOwnHandle(document);
    const focalId = location.pathname.match(/\/status\/(\d+)/)?.[1] ?? '';
    if (focalId === '') return { ownHandle, focal: null, focalArticle: null };
    const focalArticle =
      Array.from(document.querySelectorAll(ARTICLE_SELECTOR)).find(
        (article) => readPostId(article) === focalId,
      ) ?? null;
    const fromArticle = focalArticle ? readParentPost(focalArticle) : null;
    if (fromArticle?.text) this.focalCache.set(focalId, fromArticle);
    const focal = this.focalCache.get(focalId) ??
      fromArticle ?? {
        id: focalId,
        name: '',
        handle: location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\//)?.[1] ?? '',
        text: '',
        avatarUrl: '',
      };
    return { ownHandle, focal, focalArticle };
  }

  /** The parent context an article is judged against, or null when it is a
   * top-level post. Shared by the reader and the content fingerprint so both
   * agree on whether this article depends on the focal post. */
  private parentFor(article: Element, page: PageContext): ParentPost | null {
    if (!page.focal) return null;
    const isFocal = readPostId(article) === page.focal.id;
    const precedesFocal =
      page.focalArticle !== null &&
      (article.compareDocumentPosition(page.focalArticle) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    return isFocal || precedesFocal ? null : page.focal;
  }

  private contextFor(article: Element, page: PageContext): ReadContext {
    const parent = this.parentFor(article, page);
    return {
      kind: parent ? 'reply' : 'post',
      parent,
      thread: parent ? '' : readPostId(threadHeadOf(article)),
      ownHandle: page.ownHandle,
    };
  }

  private installStyles(): void {
    const styleId = 'anyfilter-hider-style';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes anyfilter-pulse { 0% { background-color: rgba(249, 115, 22, 0.3); } 50% { background-color: rgba(249, 115, 22, 0.55); } 100% { background-color: rgba(249, 115, 22, 0.3); } }
      .${FLASH_CLASS} { animation: anyfilter-pulse 500ms ease-in-out infinite !important; box-shadow: inset 6px 0 0 #f97316, inset 0 0 0 2px rgba(249, 115, 22, 0.9) !important; }
      @keyframes anyfilter-swipe {
        0% { transform: translateX(0) scale(1); box-shadow: inset 6px 0 0 #f97316, inset 0 0 0 2px rgba(249, 115, 22, 0.9); }
        25% { transform: translateX(0) scale(1.025); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22), inset 6px 0 0 #f97316, inset 0 0 0 2px rgba(249, 115, 22, 0.9); }
        100% { transform: translateX(118%) scale(1.025); opacity: 0.5; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22), inset 6px 0 0 #f97316, inset 0 0 0 2px rgba(249, 115, 22, 0.9); }
      }
      .${SLIDING_CLASS} { position: relative !important; z-index: 5 !important; background-color: rgba(255, 237, 224, 1) !important; border-radius: 12px !important; animation: anyfilter-swipe ${SLIDE_MS}ms cubic-bezier(0.45, 0, 0.85, 0.35) forwards !important; }
      .${HIDING_CLASS} { overflow: hidden !important; max-height: 0 !important; transition: max-height ${COLLAPSE_MS}ms ease-in !important; }
      .${HIDDEN_CLASS} { display: none !important; }
    `;
    (document.head ?? document.documentElement).append(style);
  }

  private articlesOf(postId: string): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(`${ARTICLE_SELECTOR}[${POST_ID_ATTRIBUTE}="${postId}"]`),
    );
  }

  private hideTargetsOf(postId: string): HTMLElement[] {
    const targets: HTMLElement[] = [];
    for (const article of this.articlesOf(postId)) {
      const cell = article.closest<HTMLElement>('[data-testid="cellInnerDiv"]');
      const target = cell?.firstElementChild;
      if (target instanceof HTMLElement) targets.push(target);
    }
    return targets;
  }

  private finishHide(target: HTMLElement, animate: boolean): void {
    const cell = target.parentElement;
    const done = (): void => {
      target.classList.remove(FLASH_CLASS, SLIDING_CLASS, HIDING_CLASS);
      target.classList.add(HIDDEN_CLASS);
      target.style.maxHeight = '';
      if (cell) cell.style.overflow = '';
    };
    if (!animate) {
      done();
      return;
    }
    if (cell) cell.style.overflow = 'hidden';
    target.style.maxHeight = `${target.offsetHeight}px`;
    target.classList.remove(FLASH_CLASS);
    target.classList.add(SLIDING_CLASS);
    setTimeout(() => {
      if (!target.classList.contains(SLIDING_CLASS)) return;
      target.classList.add(HIDING_CLASS);
      setTimeout(() => {
        if (target.classList.contains(HIDING_CLASS)) done();
      }, COLLAPSE_MS);
    }, SLIDE_MS);
  }
}
