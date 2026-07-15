import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Just above the ~37px sticky file header, so the incoming file activates as
 * its header displaces the previous one (GitHub's behavior).
 */
const ACTIVATION_OFFSET = 48;
/** Scroll-idle window used to detect the end of a smooth scroll. */
const SETTLE_IDLE_MS = 150;
/** Max tolerated drift (px) from `content-visibility: auto` before an instant correction. */
const SETTLE_TOLERANCE = 8;
/**
 * Each correction jump can itself trigger `content-visibility` re-layout that
 * shifts the target again, so corrections repeat until the drift is within
 * tolerance — capped, since some targets are unreachable (e.g. a short last
 * file that can't reach the container top).
 */
const MAX_SETTLE_ATTEMPTS = 4;

/**
 * Tracks which diff file card is "current" inside the scroll container and
 * provides click-to-scroll. Anchors are elements carrying `data-file-path`
 * (set on each DiffFile root); DOM order matches `paths` order since both
 * derive from the same visible-files list.
 *
 * Called from FileTreeSidebar (not App) so spy transitions re-render only the
 * sidebar subtree, never DiffView or the diff cards.
 */
export function useDiffScrollSpy(
  containerRef: React.RefObject<HTMLDivElement | null>,
  paths: string[],
): { activePath: string | null; scrollToFile: (path: string) => void } {
  const [activePath, setActivePath] = useState<string | null>(null);
  const suppressRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targetPathRef = useRef<string | null>(null);
  const settleAttemptsRef = useRef(0);
  const pathsRef = useRef(paths);
  pathsRef.current = paths;

  // Keyed on content, not identity, so identical file sets across WS diff
  // refreshes don't tear down the listener.
  const pathsKey = paths.join("\u0000");

  const findAnchor = useCallback(
    (path: string): HTMLElement | null => {
      const container = containerRef.current;
      if (!container) return null;
      // dataset comparison in plain JS — no CSS attribute-selector escaping
      // issues with spaces/quotes/unicode in paths.
      for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-file-path]"))) {
        if (el.dataset.filePath === path) return el;
      }
      return null;
    },
    [containerRef],
  );

  const update = useCallback(() => {
    if (suppressRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const currentPaths = pathsRef.current;
    const first = currentPaths[0];
    if (first === undefined) {
      setActivePath(null);
      return;
    }
    const containerTop = container.getBoundingClientRect().top;
    // Active = last anchor whose top sits above the activation offset; if none
    // (scrolled above the first file, e.g. CIStatus visible), the first path.
    let next = first;
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-file-path]"))) {
      const path = el.dataset.filePath;
      if (path === undefined) continue;
      if (el.getBoundingClientRect().top - containerTop <= ACTIVATION_OFFSET) next = path;
    }
    // Bottom clamp: a short final file whose top never crosses the offset
    // still becomes active when the container is scrolled to the end. Only
    // applies when the container actually overflows; otherwise the rule above
    // already picked the right answer (first file, matching GitHub on mount).
    const maxScrollTop = container.scrollHeight - container.clientHeight;
    if (maxScrollTop > 2 && container.scrollTop >= maxScrollTop - 2) {
      next = currentPaths[currentPaths.length - 1] ?? next;
    }
    setActivePath((prev) => (prev === next ? prev : next));
  }, [containerRef]);

  const startIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      // Settle correction for content-visibility: auto drift.
      const container = containerRef.current;
      const targetPath = targetPathRef.current;
      if (container && targetPath !== null && settleAttemptsRef.current < MAX_SETTLE_ATTEMPTS) {
        const el = findAnchor(targetPath);
        if (el) {
          const drift = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
          if (Math.abs(drift) > SETTLE_TOLERANCE) {
            settleAttemptsRef.current++;
            el.scrollIntoView({ block: "start" });
            // Keep suppression and re-verify after this jump settles.
            startIdleTimer();
            return;
          }
        }
      }
      targetPathRef.current = null;
      suppressRef.current = false;
      update();
    }, SETTLE_IDLE_MS);
  }, [containerRef, findAnchor, update]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      // While suppressed (click-driven smooth scroll), every scroll event
      // resets the idle timer that ends suppression.
      if (suppressRef.current) startIdleTimer();
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          update();
        });
      }
    };
    // A real user gesture ends suppression immediately: the settle correction
    // must never yank the viewport back to the clicked file against the
    // user's own scrolling.
    const cancelSuppression = () => {
      if (!suppressRef.current && targetPathRef.current === null) return;
      suppressRef.current = false;
      targetPathRef.current = null;
      settleAttemptsRef.current = 0;
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", cancelSuppression, { passive: true });
    container.addEventListener("touchstart", cancelSuppression, { passive: true });
    container.addEventListener("mousedown", cancelSuppression);
    // Initialize on mount / paths change; also re-validates a stale activePath
    // (commit switch, WS refresh) against the new file set.
    update();
    // Suppression must always have a live exit timer: the cleanup below runs
    // on every paths change and cancels it, which would otherwise freeze the
    // spy and later settle-correct against a stale target.
    if (targetPathRef.current !== null && !pathsRef.current.includes(targetPathRef.current)) {
      targetPathRef.current = null;
    }
    if (suppressRef.current) startIdleTimer();
    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", cancelSuppression);
      container.removeEventListener("touchstart", cancelSuppression);
      container.removeEventListener("mousedown", cancelSuppression);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    };
    // oxlint-disable-next-line exhaustive-deps -- pathsKey stands in for paths
  }, [pathsKey, containerRef, startIdleTimer, update]);

  // Re-validate activePath when the file set changes: fall back to the first
  // path if the previously active one no longer exists.
  useEffect(() => {
    const currentPaths = pathsRef.current;
    setActivePath((prev) =>
      prev !== null && currentPaths.includes(prev) ? prev : (currentPaths[0] ?? null),
    );
    // oxlint-disable-next-line exhaustive-deps -- pathsKey stands in for paths
  }, [pathsKey]);

  const scrollToFile = useCallback(
    (path: string) => {
      const el = findAnchor(path);
      if (!el) return;
      // Instant highlight (GitHub behavior), then suppress spy updates while
      // the smooth scroll travels.
      setActivePath(path);
      suppressRef.current = true;
      targetPathRef.current = path;
      settleAttemptsRef.current = 0;
      // Start the idle timer immediately: if the target is already at the top
      // and no scroll events fire, suppression still clears.
      startIdleTimer();
      // The nearest scrollable ancestor IS the diff scroll container (the page
      // body is h-screen overflow-hidden), and block: "start" puts the card
      // top exactly where its sticky header engages.
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [findAnchor, startIdleTimer],
  );

  return { activePath, scrollToFile };
}
