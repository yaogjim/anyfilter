/**
 * Shared shape checks for text that ends up inside an object key or a compiled
 * prompt: rule ids, rule-group ids and names, and every user-written rule field.
 */

/** Ids become object keys in the compiled question map, so they are restricted to
 * a conservative identifier shape. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const RESERVED_IDS: readonly string[] = ['__proto__', 'prototype', 'constructor'];

/** C0/C1 controls plus zero-width and bidi-override characters. These can hide or
 * reorder text inside a compiled prompt, so they are rejected outright. */
export const INVISIBLE_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

/** True when `value` carries a control or invisible character. Multi-line fields
 * may keep newlines and tabs; everything else may not. */
export function hasUnsafeChars(value: string, allowNewlines = false): boolean {
  const probe = allowNewlines ? value.replace(/[\n\t]/g, '') : value;
  return INVISIBLE_CHARS.test(probe);
}

/** A safe identifier: the allowed shape, and not a prototype-pollution name. */
export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value) && !RESERVED_IDS.includes(value);
}
