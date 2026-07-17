import React, { useMemo, useRef } from "react";
import { DiffView } from "./components/DiffView.tsx";
import { Toolbar } from "./components/Toolbar.tsx";
import { CIStatus } from "./components/CIStatus.tsx";
import { FileTreeSidebar } from "./components/FileTreeSidebar.tsx";
import { PlanView } from "./components/PlanView.tsx";
import { ReviewView } from "./components/ReviewView.tsx";
import { LauncherStatus } from "./components/LauncherStatus.tsx";
import { ProjectList } from "./components/ProjectList.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { useDiff, type DiffMode } from "./hooks/useDiff.ts";
import { useWebSocket } from "./hooks/useWebSocket.ts";
import { useHashRoute } from "./hooks/useHashRoute.ts";
import { useStatus } from "./hooks/useStatus.ts";
import { usePRData } from "./hooks/usePRData.ts";
import { useLauncher } from "./hooks/useLauncher.ts";
import { ReviewQueueProvider } from "./hooks/useReviewQueue.tsx";
import { visibleDiffFiles } from "./lib/file-tree.ts";
import "./index.css";

type RouteInfo = ReturnType<typeof useHashRoute>["route"];

function ProjectWorkspace({
  route,
  navigate,
  hubMode,
}: {
  route: RouteInfo;
  navigate: (path: string) => void;
  hubMode: boolean;
}) {
  const {
    branch,
    projectName,
    projectStatus,
    hasTerminal,
    actions,
    hasPlan,
    hasReview,
    hasUncommittedChanges,
    loading: statusLoading,
    error: statusError,
  } = useStatus();
  // Default the diff view to the uncommitted changes when the working tree is
  // dirty, otherwise fall back to the full branch/PR diff (nothing uncommitted
  // to show). `null` defers the initial fetch until git status resolves; on a
  // status error we default to "auto" so the diff still loads.
  const defaultDiffMode: DiffMode | null = statusError
    ? "auto"
    : statusLoading
      ? null
      : hasUncommittedChanges
        ? "uncommitted"
        : "auto";
  const {
    diff,
    loading,
    refreshing,
    error,
    refresh,
    selectedCommit,
    mode,
    selectCommit,
    clearCommit,
    showUncommitted,
  } = useDiff(defaultDiffMode);
  const { prUrl, prTitle, prState, prNumber, checks, prComments } = usePRData();
  const { hasLauncher, servers } = useLauncher();

  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleFiles = useMemo(() => visibleDiffFiles(diff), [diff]);
  // Page "home" only reaches the workspace in single mode (hub home is
  // intercepted at App level), where it renders the uncommitted diff.
  const showSidebar =
    (route.page === "home" || route.page === "diff" || route.page === "commit") &&
    visibleFiles.length > 0 &&
    !error;

  // Build hash paths, prefixed with the project in hub mode
  const projectPath = (sub: string) =>
    route.project ? `/p/${route.project}${sub ? `/${sub}` : ""}` : `/${sub}`;

  return (
    <ReviewQueueProvider>
      <div className="h-screen max-w-full overflow-hidden bg-[#0d1117] text-[#c9d1d9] flex flex-col">
        {refreshing && (
          <div className="fixed top-0 left-0 right-0 z-50 h-0.5 bg-[#1a1e24] overflow-hidden">
            <div className="h-full bg-[#58a6ff] animate-progress-bar" />
          </div>
        )}
        <Toolbar
          branch={branch}
          projectName={projectName}
          projectStatus={projectStatus}
          hasTerminal={hasTerminal}
          actions={actions}
          prUrl={prUrl}
          prState={prState}
          prNumber={prNumber}
          onShowProjects={hubMode ? () => navigate("/") : undefined}
          onShowDiff={() => {
            navigate(projectPath(""));
            clearCommit();
          }}
          onShowCommitList={() => navigate(projectPath("commits"))}
          onShowPlan={hasPlan ? () => navigate(projectPath("plan")) : undefined}
          onShowReview={hasReview ? () => navigate(projectPath("review")) : undefined}
        />
        {hasLauncher && servers.length > 0 && <LauncherStatus servers={servers} />}
        <div
          className={`flex-1 flex min-h-0 transition-opacity duration-200 ${refreshing ? "opacity-60" : "opacity-100"}`}
        >
          {showSidebar && <FileTreeSidebar files={visibleFiles} scrollContainerRef={scrollRef} />}
          <div ref={scrollRef} className="flex-1 min-w-0 overflow-auto px-4 pb-4">
            {route.page === "plan" ? (
              <div className="pt-4">
                <PlanView onBack={() => navigate(projectPath(""))} hasTerminal={hasTerminal} />
              </div>
            ) : route.page === "review" ? (
              <div className="pt-4">
                <ReviewView onBack={() => navigate(projectPath(""))} hasTerminal={hasTerminal} />
              </div>
            ) : (
              <>
                {(checks.length > 0 || prUrl) && (
                  <div className="mt-4 mb-4">
                    <CIStatus checks={checks} prTitle={prTitle} prUrl={prUrl} prState={prState} />
                  </div>
                )}
                <DiffView
                  diff={diff}
                  loading={loading}
                  error={error}
                  onRefresh={refresh}
                  hasTerminal={hasTerminal}
                  selectedCommit={selectedCommit}
                  showCommitList={route.page === "commits"}
                  hasUncommittedChanges={hasUncommittedChanges}
                  mode={mode}
                  prComments={prComments.filter((c) => !c.isResolved)}
                  onSelectCommit={(commit) => {
                    navigate(projectPath(`commit/${commit.hash}`));
                    selectCommit(commit);
                  }}
                  onClearCommit={() => {
                    navigate(projectPath(""));
                    clearCommit();
                  }}
                  onShowUncommitted={() => {
                    navigate(projectPath(""));
                    showUncommitted();
                  }}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </ReviewQueueProvider>
  );
}

export default function App() {
  const { route, navigate } = useHashRoute();
  const { hubMode, loading, error: statusError } = useStatus();

  // Establish WebSocket connection (individual hooks subscribe via ws-message events)
  useWebSocket(() => {});

  // Hub mode home: project list. Single mode home: the diff workspace.
  // On a failed status fetch, fall through to the workspace instead of
  // spinning on "Loading..." forever.
  if (route.page === "home" && (hubMode || (loading && !statusError))) {
    return (
      <ToastProvider>
        <div className="h-screen max-w-full overflow-auto bg-[#0d1117] text-[#c9d1d9] px-4 pb-4">
          {loading ? (
            <div className="flex items-center justify-center h-64 text-gray-500">Loading...</div>
          ) : (
            <ProjectList onSelectProject={(id) => navigate(`/p/${id}`)} />
          )}
        </div>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <ProjectWorkspace
        key={route.project ?? "single"}
        route={route}
        navigate={navigate}
        hubMode={hubMode}
      />
    </ToastProvider>
  );
}
