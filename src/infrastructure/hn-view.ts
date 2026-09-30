import {
  hnPost,
  hnSiteOf,
  hnItemIdOf,
  isHnItemId,
  isHnListingPath,
  isHnPostId,
  type HnItem,
} from '../domain/hn';
import type { Post } from '../domain/post';
import type { ReviewSnapshot } from '../domain/review';
import { hashString } from '../domain/rule';
import type { TimelineView } from '../domain/timeline-view';

const PROCESSED_ATTRIBUTE = 'data-anyfilter';
const SIGNATURE_ATTRIBUTE = 'data-anyfilter-sig';
const HIDDEN_CLASS = 'anyfilter-hn-hidden';
const STYLE_ID = 'anyfilter-hn-style';
const ROW_SELECTOR = 'tr.athing.submission';

/** The row under a submission that carries the score and the submitter. */
function subtextRowOf(row: Element): Element | null {
  const next = row.nextElementSibling;
  return next !== null && next.querySelector('td.subtext') !== null ? next : null;
}

/** The three table rows one submission is made of: the title, the score line, and
 * the gap under it. Hiding all three is what makes it disappear instead of
 * leaving an empty band. */
function rowsOf(row: Element): Element[] {
  const rows = [row];
  const subtext = subtextRowOf(row);
  if (subtext === null) return rows;
  rows.push(subtext);
  const spacer = subtext.nextElementSibling;
  if (spacer !== null && spacer.classList.contains('spacer')) rows.push(spacer);
  return rows;
}

/** One submission read off its title row, or null when it is not one we can judge. */
export function readHnRow(row: Element): HnItem | null {
  if (!isHnItemId(row.id)) return null;
  const link = row.querySelector('span.titleline > a');
  if (link === null) return null;
  const title = (link.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (title === '') return null;
  const user = subtextRowOf(row)?.querySelector('a.hnuser')?.textContent?.trim() ?? '';
  return { id: row.id, title, site: hnSiteOf(link.getAttribute('href') ?? ''), user };
}

/**
 * The Hacker News list page as a timeline the feed filter can work on. Same shape
 * as the X one, so `FeedFilter` is used unchanged; what differs is how a post is
 * found and how it is hidden.
 */
export class HnView implements TimelineView {
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
    if (!isHnListingPath(location.pathname)) return [];
    const posts: Post[] = [];
    for (const row of document.querySelectorAll(ROW_SELECTOR)) {
      const item = readHnRow(row);
      if (item === null) continue;
      const signature = hashString(`${item.title}\u0000${item.site}\u0000${item.user}`);
      const processed = row.getAttribute(PROCESSED_ATTRIBUTE) === questionsKey;
      if (processed && row.getAttribute(SIGNATURE_ATTRIBUTE) === signature) continue;
      row.setAttribute(PROCESSED_ATTRIBUTE, questionsKey);
      row.setAttribute(SIGNATURE_ATTRIBUTE, signature);
      posts.push(hnPost(item));
    }
    return posts;
  }

  read(postId: string): Post | null {
    const row = this.rowOf(postId);
    const item = row === null ? null : readHnRow(row);
    return item === null ? null : hnPost(item);
  }

  unmark(postId: string): void {
    const row = this.rowOf(postId);
    if (row === null) return;
    row.removeAttribute(PROCESSED_ATTRIBUTE);
    row.removeAttribute(SIGNATURE_ATTRIBUTE);
  }

  hide(postId: string, _animate: boolean): void {
    const row = this.rowOf(postId);
    if (row === null) return;
    for (const part of rowsOf(row)) part.classList.add(HIDDEN_CLASS);
  }

  show(postId: string): void {
    const row = this.rowOf(postId);
    if (row === null) return;
    for (const part of rowsOf(row)) part.classList.remove(HIDDEN_CLASS);
  }

  // Review mode belongs to X. Nothing is drawn on a Hacker News row.
  decorate(_postId: string, _snapshot: ReviewSnapshot): void {}

  clearDecoration(_postId: string): void {}

  private rowOf(postId: string): Element | null {
    if (!isHnPostId(postId)) return null;
    // The id is digits only (checked above), so it is safe inside a selector.
    return document.querySelector(`${ROW_SELECTOR}[id="${hnItemIdOf(postId)}"]`);
  }

  private installStyles(): void {
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.${HIDDEN_CLASS} { display: none !important; }`;
    (document.head ?? document.documentElement).append(style);
  }
}
