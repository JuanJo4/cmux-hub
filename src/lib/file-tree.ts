import type { DiffFile, ParsedDiff } from "./diff-parser.ts";

export type FileStatus = "added" | "deleted" | "renamed" | "modified";

export type TreeFile = {
  type: "file";
  /** basename */
  name: string;
  /** full newPath — the key used everywhere */
  path: string;
  /** for renamed tooltip "old → new" */
  oldPath: string;
  status: FileStatus;
  additions: number;
  deletions: number;
};

export type TreeDir = {
  type: "dir";
  /** may be a compressed label, e.g. "src/components" */
  name: string;
  /** deepest dir's full path — stable collapse key */
  path: string;
  children: TreeNode[];
};

export type TreeNode = TreeDir | TreeFile;

/** Single source of truth for the generated-file filter (shared with DiffView). */
export function visibleDiffFiles(diff: ParsedDiff): DiffFile[] {
  return diff.filter((file) => !file.generated);
}

/** Precedence MUST match DiffFile's badge: isNew > isDeleted > isRenamed > modified. */
export function fileStatus(f: Pick<DiffFile, "isNew" | "isDeleted" | "isRenamed">): FileStatus {
  if (f.isNew) return "added";
  if (f.isDeleted) return "deleted";
  if (f.isRenamed) return "renamed";
  return "modified";
}

/** Sum line.type === "add" / "delete" across hunks (same loop as DiffFile.fileStat). */
export function fileCounts(f: Pick<DiffFile, "hunks">): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of f.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") additions++;
      else if (line.type === "delete") deletions++;
    }
  }
  return { additions, deletions };
}

/**
 * Case-insensitive substring match of the trimmed query against newPath.
 * Empty/whitespace query returns the input unchanged. Runs BEFORE buildFileTree.
 */
export function filterFiles(files: DiffFile[], query: string): DiffFile[] {
  const q = query.trim().toLowerCase();
  if (!q) return files;
  return files.filter((file) => file.newPath.toLowerCase().includes(q));
}

type MutableDir = {
  name: string;
  path: string;
  dirs: Map<string, MutableDir>;
  files: TreeFile[];
};

/** Dirs and files each sorted case-insensitively and numeric-aware, deterministic tiebreak. */
function compareNames(a: string, b: string): number {
  const primary = a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  return primary !== 0 ? primary : a.localeCompare(b);
}

/** Sort + freeze (post-order): directories strictly before files, each group sorted. */
function freezeDir(dir: MutableDir): TreeDir {
  const dirs = [...dir.dirs.values()].map(freezeDir).sort((a, b) => compareNames(a.name, b.name));
  const files = [...dir.files].sort((a, b) => compareNames(a.name, b.name));
  return { type: "dir", name: dir.name, path: dir.path, children: [...dirs, ...files] };
}

/**
 * Compress (top-down): while a dir's only child is a dir, merge them —
 * label joins with "/", path becomes the deepest dir's full path.
 * A dir whose single child is a FILE never merges.
 */
function compressDir(dir: TreeDir): TreeDir {
  let name = dir.name;
  let path = dir.path;
  let children = dir.children;
  while (children.length === 1 && children[0]?.type === "dir") {
    const child = children[0];
    name = `${name}/${child.name}`;
    path = child.path;
    children = child.children;
  }
  return {
    type: "dir",
    name,
    path,
    children: children.map((c) => (c.type === "dir" ? compressDir(c) : c)),
  };
}

/** Build a sorted, path-compressed tree from the already-visible (and possibly filtered) list. */
export function buildFileTree(files: DiffFile[]): TreeNode[] {
  const root: MutableDir = { name: "", path: "", dirs: new Map(), files: [] };
  const seen = new Set<string>();

  for (const file of files) {
    // Duplicate newPath (shouldn't occur in git output): keep the first, skip the rest.
    if (seen.has(file.newPath)) continue;
    seen.add(file.newPath);

    // Drop empty segments — guards odd leading/double slashes.
    const segments = file.newPath.split("/").filter((s) => s.length > 0);
    const basename = segments[segments.length - 1];
    if (basename === undefined) continue;

    let dir = root;
    const walked: string[] = [];
    for (const segment of segments.slice(0, -1)) {
      walked.push(segment);
      let child = dir.dirs.get(segment);
      if (!child) {
        child = { name: segment, path: walked.join("/"), dirs: new Map(), files: [] };
        dir.dirs.set(segment, child);
      }
      dir = child;
    }

    const { additions, deletions } = fileCounts(file);
    dir.files.push({
      type: "file",
      name: basename,
      path: file.newPath,
      oldPath: file.oldPath,
      status: fileStatus(file),
      additions,
      deletions,
    });
  }

  // Compression applies at the root level too: each top-level dir compresses its own chain.
  return freezeDir(root).children.map((node) => (node.type === "dir" ? compressDir(node) : node));
}

/**
 * Reorder diff files to match the tree's display order (depth-first walk of
 * buildFileTree, dirs before files) so the rendered diff cards follow the
 * sidebar, like GitHub. Duplicate newPaths share the first occurrence's rank
 * and keep their input order (stable sort), preserving the scroll-spy
 * invariant that DOM card order equals paths order.
 */
export function orderFilesByTree(files: DiffFile[]): DiffFile[] {
  const rank = new Map<string, number>();
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "dir") walk(node.children);
      else rank.set(node.path, rank.size);
    }
  };
  walk(buildFileTree(files));
  return files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => {
      const ra = rank.get(a.file.newPath) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.file.newPath) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb || a.index - b.index;
    })
    .map((entry) => entry.file);
}
