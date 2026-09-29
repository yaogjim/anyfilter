import type { Post } from './post';
import type { ReviewSnapshot } from './review';

export interface TimelineView {
  scan(questionsKey: string): Post[];
  read(postId: string): Post | null;
  unmark(postId: string): void;
  hide(postId: string, animate: boolean): void;
  show(postId: string): void;
  /** Review mode: draws the judgement on the post and leaves it visible. */
  decorate(postId: string, snapshot: ReviewSnapshot): void;
  clearDecoration(postId: string): void;
  onChange(listener: () => void): () => void;
}
