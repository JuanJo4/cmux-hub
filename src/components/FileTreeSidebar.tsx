import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
  SquareArrowRight,
  SquareDot,
  SquareMinus,
  SquarePlus,
} from "lucide-react";
import type { DiffFile as DiffFileType } from "../lib/diff-parser.ts";
import {
  buildFileTree,
  filterFiles,
  orderFilesByTree,
  type FileStatus,
  type TreeNode,
} from "../lib/file-tree.ts";
import { useDiffScrollSpy } from "../hooks/useDiffScrollSpy.ts";

const STORAGE_KEY = "cmux-hub.fileTreeOpen";
const EMPTY_SET: ReadonlySet<string> = new Set();

function readOpenPref(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeOpenPref(open: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  } catch {
    // localStorage unavailable (privacy mode) — preference stays in-memory
  }
}

// lucide equivalents of GitHub's octicon diff icons
const STATUS_ICONS: Record<
  FileStatus,
  { Icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  added: { Icon: SquarePlus, className: "text-[#3fb950]" },
  deleted: { Icon: SquareMinus, className: "text-[#f85149]" },
  modified: { Icon: SquareDot, className: "text-[#d29922]" },
  renamed: { Icon: SquareArrowRight, className: "text-[#a371f7]" },
};

// A path can exist as both a file and a dir in one diff (file -> directory
// conversion), so sibling keys must be namespaced by node type.
const nodeKey = (n: TreeNode) => `${n.type}:${n.path}`;

const ROW_CLASS =
  "relative flex h-8 w-full items-center gap-1.5 rounded-md pr-2 text-sm text-[#e6edf3] hover:bg-[#b1bac41f] text-left";
const TOGGLE_BUTTON_CLASS = "p-1 rounded text-[#848d97] hover:text-[#c9d1d9] hover:bg-[#161b22]";

function TreeRow({
  node,
  depth,
  activePath,
  collapsedDirs,
  onToggleDir,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  collapsedDirs: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isActive = node.type === "file" && node.path === activePath;
  const rowRef = useRef<HTMLButtonElement | null>(null);

  // Keep the active row visible in the tree's own scroller (safe: the main
  // diff scroller is not an ancestor of the row).
  useEffect(() => {
    if (isActive) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [isActive]);

  const indent = { paddingLeft: depth * 16 + 8 };

  if (node.type === "dir") {
    const collapsed = collapsedDirs.has(node.path);
    const Chevron = collapsed ? ChevronRight : ChevronDown;
    return (
      <>
        <button
          type="button"
          role="treeitem"
          aria-expanded={!collapsed}
          className={ROW_CLASS}
          style={indent}
          onClick={() => onToggleDir(node.path)}
        >
          <Chevron className="h-4 w-4 shrink-0 text-[#848d97]" />
          <Folder className="h-4 w-4 shrink-0 text-[#848d97] fill-[#848d97]" />
          <span className="truncate">{node.name}</span>
        </button>
        {!collapsed &&
          node.children.map((child) => (
            <TreeRow
              key={nodeKey(child)}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              collapsedDirs={collapsedDirs}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
            />
          ))}
      </>
    );
  }

  const { Icon, className: statusClass } = STATUS_ICONS[node.status];
  return (
    <button
      ref={rowRef}
      type="button"
      role="treeitem"
      aria-current={isActive ? "true" : undefined}
      className={`${ROW_CLASS}${isActive ? " bg-[#b1bac414]" : ""}`}
      style={indent}
      onClick={() => onSelectFile(node.path)}
    >
      {isActive && (
        <span className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-md bg-[#1f6feb]" />
      )}
      {/* chevron-width spacer aligns file icons under folder icons */}
      <span className="w-4 shrink-0" />
      <FileIcon className="h-4 w-4 shrink-0 text-[#848d97]" />
      <span
        className="truncate"
        title={node.status === "renamed" ? `${node.oldPath} → ${node.path}` : node.path}
      >
        {node.name}
      </span>
      <span
        className="ml-auto h-4 w-4 shrink-0"
        title={`${node.status}: +${node.additions} −${node.deletions}`}
      >
        <Icon className={`h-4 w-4 ${statusClass}`} />
      </span>
    </button>
  );
}

type Props = {
  /** Already generated-filtered; any order (tree order is derived here). */
  files: DiffFileType[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
};

export function FileTreeSidebar({ files, scrollContainerRef }: Props) {
  const [open, setOpen] = useState(readOpenPref);
  const [query, setQuery] = useState("");
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(EMPTY_SET);

  // Tree display order — must match DiffView's card order (scroll-spy assumes
  // DOM order equals paths order).
  const paths = useMemo(() => orderFilesByTree(files).map((f) => f.newPath), [files]);
  const { activePath, scrollToFile } = useDiffScrollSpy(scrollContainerRef, paths);
  const tree = useMemo(() => buildFileTree(filterFiles(files, query)), [files, query]);

  const filtering = query.trim().length > 0;
  // Filtering force-expands; clearing the query restores the user's collapse state.
  const effectiveCollapsed = filtering ? EMPTY_SET : collapsedDirs;

  const setOpenPersist = (next: boolean) => {
    setOpen(next);
    writeOpenPref(next);
  };

  const toggleDir = (path: string) => {
    if (filtering) return; // chevron clicks are no-ops while filtering
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (!open) {
    return (
      <div className="hidden lg:flex w-10 shrink-0 flex-col items-center border-r border-[#30363d] pt-3">
        <button
          type="button"
          aria-label="Show file tree"
          title="Show file tree"
          className={TOGGLE_BUTTON_CLASS}
          onClick={() => setOpenPersist(true)}
        >
          <PanelLeftOpen size={16} />
        </button>
      </div>
    );
  }

  return (
    <aside className="hidden lg:flex w-72 shrink-0 flex-col border-r border-[#30363d]">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-xs text-[#848d97]">Files ({files.length})</span>
        <button
          type="button"
          aria-label="Hide file tree"
          title="Hide file tree"
          className={TOGGLE_BUTTON_CLASS}
          onClick={() => setOpenPersist(false)}
        >
          <PanelLeftClose size={16} />
        </button>
      </div>
      <div className="px-3 pb-2">
        <input
          aria-label="Filter changed files"
          placeholder="Filter changed files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full h-8 rounded-md border border-[#30363d] bg-[#0d1117] px-3 text-sm text-[#c9d1d9] placeholder:text-[#6e7681] focus:border-[#58a6ff] focus:outline-none"
        />
      </div>
      <div
        role="tree"
        aria-label="Changed files"
        data-testid="file-tree"
        className="flex-1 overflow-y-auto px-2 pb-4"
      >
        {tree.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-[#848d97]">No files found</div>
        ) : (
          tree.map((node) => (
            <TreeRow
              key={nodeKey(node)}
              node={node}
              depth={0}
              activePath={activePath}
              collapsedDirs={effectiveCollapsed}
              onToggleDir={toggleDir}
              onSelectFile={scrollToFile}
            />
          ))
        )}
      </div>
    </aside>
  );
}
