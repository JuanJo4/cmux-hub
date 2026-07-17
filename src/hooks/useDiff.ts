import { useEffect, useCallback, useRef, useActionState, startTransition } from "react";
import { api, getApiProject } from "../lib/api.ts";
import { parseDiff, type ParsedDiff } from "../lib/diff-parser.ts";

export type SelectedCommit = { hash: string; message: string; relativeDate: string };

// "auto" = branch-aware range (whole branch/PR diff on a feature branch);
// "uncommitted" = working-tree changes only (git diff HEAD + untracked).
export type DiffMode = "auto" | "uncommitted";

type CommitViewState = {
  diff: ParsedDiff;
  rawDiff: string;
  commit: SelectedCommit | null;
  error: string | null;
};

type AutoDiffState = {
  diff: ParsedDiff;
  rawDiff: string;
  base: string | null;
  mode: DiffMode;
  error: string | null;
};

const initialCommitView: CommitViewState = { diff: [], rawDiff: "", commit: null, error: null };
const initialAutoDiff: AutoDiffState = {
  diff: [],
  rawDiff: "",
  base: null,
  mode: "auto",
  error: null,
};

/**
 * @param defaultMode Mode for the initial load. Pass `null` to defer the first
 *   fetch until the caller knows which mode to use (e.g. waiting on git status
 *   to decide between "uncommitted" and "auto"); the fetch fires once it
 *   resolves to a non-null mode.
 */
export function useDiff(defaultMode: DiffMode | null = "auto") {
  // Tracks the mode of the last auto/uncommitted fetch so WebSocket-driven
  // refreshes re-fetch in the same mode the user is currently viewing.
  // `null` until the initial load runs, so deferred/early events are no-ops.
  const modeRef = useRef<DiffMode | null>(null);

  const [autoDiff, dispatchAutoDiff, isAutoLoading] = useActionState(
    async (_prev: AutoDiffState, mode: DiffMode): Promise<AutoDiffState> => {
      try {
        const result =
          mode === "uncommitted" ? await api.getUncommittedDiff() : await api.getAutoDiff();
        return {
          diff: result.files ?? parseDiff(result.diff),
          rawDiff: result.diff,
          base: result.base,
          mode,
          error: null,
        };
      } catch (e) {
        return {
          ..._prev,
          mode,
          error: e instanceof Error ? e.message : "Failed to fetch diff",
        };
      }
    },
    initialAutoDiff,
  );

  const [commitView, dispatchCommitView, isCommitLoading] = useActionState(
    async (_prev: CommitViewState, action: SelectedCommit | null): Promise<CommitViewState> => {
      if (!action) return initialCommitView;
      try {
        const result = await api.getCommitDiff(action.hash);
        return {
          diff: result.files ?? parseDiff(result.diff),
          rawDiff: result.diff,
          commit: action,
          error: null,
        };
      } catch (e) {
        return {
          diff: [],
          rawDiff: "",
          commit: action,
          error: e instanceof Error ? e.message : "Failed to fetch commit diff",
        };
      }
    },
    initialCommitView,
  );

  const fetchDiff = useCallback(() => {
    // No-op until the initial mode has been chosen (see the mount effect).
    if (modeRef.current === null) return;
    const mode = modeRef.current;
    startTransition(() => dispatchAutoDiff(mode));
  }, [dispatchAutoDiff]);

  const selectCommit = useCallback(
    (commit: SelectedCommit) => {
      startTransition(() => dispatchCommitView(commit));
    },
    [dispatchCommitView],
  );

  // Back to the default branch-aware diff (whole branch/PR on a feature branch).
  const clearCommit = useCallback(() => {
    modeRef.current = "auto";
    startTransition(() => dispatchCommitView(null));
    fetchDiff();
  }, [dispatchCommitView, fetchDiff]);

  // Show only working-tree (uncommitted) changes.
  const showUncommitted = useCallback(() => {
    modeRef.current = "uncommitted";
    startTransition(() => dispatchCommitView(null));
    fetchDiff();
  }, [dispatchCommitView, fetchDiff]);

  // Initial load: fire once the desired default mode is known. Guarded so it
  // runs a single time even though `defaultMode` may resolve from null → mode
  // and status may keep refreshing afterward.
  useEffect(() => {
    if (defaultMode === null || modeRef.current !== null) return;
    modeRef.current = defaultMode;
    fetchDiff();
  }, [defaultMode, fetchDiff]);

  // Listen for diff-updated WebSocket events
  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent).detail as { type: string; project?: string };
      if (msg.project && msg.project !== getApiProject()) return;
      if (msg.type === "diff-updated") {
        fetchDiff();
      }
    };
    window.addEventListener("ws-message", handler);
    return () => window.removeEventListener("ws-message", handler);
  }, [fetchDiff]);

  // When a commit is selected, use commitView state; otherwise auto-diff state
  const isCommitSelected = commitView.commit !== null;

  return {
    diff: isCommitSelected ? commitView.diff : autoDiff.diff,
    rawDiff: isCommitSelected ? commitView.rawDiff : autoDiff.rawDiff,
    loading: isAutoLoading || isCommitLoading,
    refreshing: isAutoLoading,
    error: isCommitSelected ? commitView.error : autoDiff.error,
    base: autoDiff.base,
    mode: autoDiff.mode,
    selectedCommit: commitView.commit,
    refresh: fetchDiff,
    selectCommit,
    clearCommit,
    showUncommitted,
  };
}
