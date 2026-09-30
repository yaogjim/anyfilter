import { useCallback, useEffect, useRef, useState } from 'react';

/** Distance from the viewport top below which a section counts as "reached":
 * clears the sticky header and leaves a little of the previous section visible. */
const READ_LINE_PX = 140;

/** Pure: the section being read, given each section's top edge (same order as
 * `order`; `null` for a section that is not on the page). The current section is
 * the last one whose top has passed the reading line, and at the very bottom of
 * the page it is the last section, even when that one is too short to ever
 * reach the line. */
export function activeSection(
  order: readonly string[],
  tops: ReadonlyArray<number | null>,
  atBottom: boolean,
): string {
  let current = order[0] ?? '';
  order.forEach((id, index) => {
    const top = tops[index];
    if (top !== null && top !== undefined && top <= READ_LINE_PX) current = id;
  });
  if (atBottom) {
    for (let index = order.length - 1; index >= 0; index -= 1) {
      if (tops[index] !== null) return order[index] ?? current;
    }
  }
  return current;
}

/**
 * Which of the given sections the reader is currently looking at, for a table of
 * contents. Driven by scroll position (throttled to one read per frame) rather
 * than by intersection, because a tall section and several short ones at the end
 * of the page cannot be told apart by what is merely visible.
 *
 * `ready` must turn true only once every element with one of the `ids` is in the
 * DOM (the page renders its sections after settings load). `select` marks a
 * section current right away, so a clicked link highlights without waiting for
 * the smooth scroll to finish.
 */
export function useScrollSpy(
  ids: readonly string[],
  ready: boolean,
): { active: string; select: (id: string) => void } {
  const [active, setActive] = useState(ids[0] ?? '');
  // A link click owns the highlight until the scroll it started is over; the
  // scroll handler would otherwise flicker through every section on the way.
  const pinned = useRef<number | null>(null);
  const key = ids.join('\n');

  useEffect(() => {
    if (!ready) return;
    const order = key.split('\n');
    let frame = 0;
    const update = (): void => {
      frame = 0;
      if (pinned.current !== null) return;
      const tops = order.map((id) => document.getElementById(id)?.getBoundingClientRect().top ?? null);
      const root = document.documentElement;
      const atBottom = window.scrollY > 0 && root.scrollHeight - window.scrollY - window.innerHeight < 4;
      setActive(activeSection(order, tops, atBottom));
    };
    const schedule = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [key, ready]);

  useEffect(
    () => () => {
      if (pinned.current !== null) window.clearTimeout(pinned.current);
    },
    [],
  );

  const select = useCallback((id: string) => {
    setActive(id);
    if (pinned.current !== null) window.clearTimeout(pinned.current);
    pinned.current = window.setTimeout(() => {
      pinned.current = null;
    }, 800);
  }, []);

  return { active, select };
}
