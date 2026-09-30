export type PostKind = 'post' | 'reply';

/** Where a post was read. Absent means X, so everything stored before there was a
 * second site stays valid without a migration. */
export type PostSource = 'x' | 'hn';

export interface ParentPost {
  id: string;
  name: string;
  handle: string;
  text: string;
  avatarUrl: string;
}

export interface Post {
  id: string;
  kind: PostKind;
  parent: ParentPost | null;
  thread: string;
  own: boolean;
  name: string;
  handle: string;
  time: string;
  text: string;
  promoted: boolean;
  avatarUrl: string;
  imageUrls: string[];
  hasVideo: boolean;
  quotedName: string;
  quotedText: string;
  truncated: boolean;
  /** Only set for sites other than X. */
  source?: PostSource;
  /** Link to the post itself, for sites other than X. X posts build theirs from
   * the handle and id. */
  url?: string;
}

export function postSource(post: Post): PostSource {
  return post.source ?? 'x';
}

export function postUrl(post: Post): string {
  if (post.url !== undefined && post.url !== '') return post.url;
  return statusUrl(post.handle, post.id);
}

/** The author's page on the site the post came from. */
export function authorUrl(post: Post): string {
  return postSource(post) === 'hn'
    ? `https://news.ycombinator.com/user?id=${encodeURIComponent(post.handle)}`
    : profileUrl(post.handle);
}

export function statusUrl(handle: string, id: string): string {
  return `https://x.com/${handle || 'i'}/status/${id}`;
}

export function profileUrl(handle: string): string {
  return `https://x.com/${handle}`;
}

export function isParentPost(value: unknown): value is ParentPost {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.handle === 'string' &&
    typeof record.text === 'string' &&
    typeof record.avatarUrl === 'string'
  );
}

export function isPost(value: unknown): value is Post {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    (record.kind === 'post' || record.kind === 'reply') &&
    (record.parent === null || isParentPost(record.parent)) &&
    typeof record.thread === 'string' &&
    typeof record.own === 'boolean' &&
    typeof record.name === 'string' &&
    typeof record.handle === 'string' &&
    typeof record.time === 'string' &&
    typeof record.text === 'string' &&
    typeof record.promoted === 'boolean' &&
    typeof record.avatarUrl === 'string' &&
    Array.isArray(record.imageUrls) &&
    record.imageUrls.every((url) => typeof url === 'string') &&
    typeof record.hasVideo === 'boolean' &&
    typeof record.quotedName === 'string' &&
    typeof record.quotedText === 'string' &&
    typeof record.truncated === 'boolean' &&
    (record.source === undefined || record.source === 'x' || record.source === 'hn') &&
    (record.url === undefined || typeof record.url === 'string')
  );
}

/**
 * The single definition of "what a judgement depends on" for one post. Every
 * field that can change the compiled prompt or a local decision is included;
 * cosmetic and volatile fields (avatar image, relative time) are not, because
 * they change on their own and must not invalidate a result.
 *
 * The score cache is keyed with this and the feed compares it, so a post whose
 * text was edited, whose quote or parent context changed, or whose DOM cell was
 * reused for a different post can never be served a stale answer.
 */
export function postContentKey(post: Post): string {
  return JSON.stringify([
    post.kind,
    post.own,
    post.promoted,
    post.name,
    post.handle,
    post.text,
    post.truncated,
    post.quotedName,
    post.quotedText,
    post.hasVideo,
    post.imageUrls,
    post.thread,
    post.parent ? [post.parent.id, post.parent.handle, post.parent.text] : null,
    // Appended only for other sites, so the key of every X post is what it always was
    // and no stored score is invalidated.
    ...(postSource(post) === 'x' ? [] : [postSource(post)]),
  ]);
}

/** True when nothing a judgement depends on changed, including quote and parent
 * context and same-length edits to the body. */
export function samePostContent(a: Post, b: Post): boolean {
  return postContentKey(a) === postContentKey(b);
}
