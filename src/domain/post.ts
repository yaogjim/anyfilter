export type PostKind = 'post' | 'reply';

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
}

export function postUrl(post: Post): string {
  return statusUrl(post.handle, post.id);
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
    typeof record.truncated === 'boolean'
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
  ]);
}

/** True when nothing a judgement depends on changed, including quote and parent
 * context and same-length edits to the body. */
export function samePostContent(a: Post, b: Post): boolean {
  return postContentKey(a) === postContentKey(b);
}
