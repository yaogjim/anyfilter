/** Attribute on every node the review UI injects, so the timeline's mutation
 * observer can tell our own changes from X's. */
export const HOST_ATTRIBUTE = 'data-anyfilter-host';

/** True for a node the review UI created. */
export function isReviewNode(node: Node): boolean {
  return node instanceof Element && node.hasAttribute(HOST_ATTRIBUTE);
}

/** Set on the post whose review panel is open, so its outline stays fully drawn. */
export const CURRENT_ATTRIBUTE = 'data-anyfilter-current';
