import { test, expect, describe } from "bun:test";
import type { DiffFile, DiffHunk, DiffLineType } from "../lib/diff-parser.ts";
import {
  buildFileTree,
  fileCounts,
  fileStatus,
  filterFiles,
  orderFilesByTree,
  visibleDiffFiles,
  type TreeDir,
  type TreeFile,
} from "../lib/file-tree.ts";

function makeHunk(types: DiffLineType[]): DiffHunk {
  return {
    header: "@@ -1 +1 @@",
    oldStart: 1,
    oldCount: types.length,
    newStart: 1,
    newCount: types.length,
    lines: types.map((type) => ({
      type,
      content: "",
      oldLineNumber: null,
      newLineNumber: null,
    })),
  };
}

function makeFile(newPath: string, opts: Partial<DiffFile> = {}): DiffFile {
  return {
    oldPath: opts.oldPath ?? newPath,
    newPath,
    hunks: opts.hunks ?? [],
    isNew: opts.isNew ?? false,
    isDeleted: opts.isDeleted ?? false,
    isRenamed: opts.isRenamed ?? false,
    ...(opts.generated !== undefined ? { generated: opts.generated } : {}),
  };
}

function asDir(node: unknown): TreeDir {
  expect((node as TreeDir).type).toBe("dir");
  return node as TreeDir;
}

function asFile(node: unknown): TreeFile {
  expect((node as TreeFile).type).toBe("file");
  return node as TreeFile;
}

describe("buildFileTree", () => {
  test("empty input returns empty tree", () => {
    expect(buildFileTree([])).toEqual([]);
  });

  test("single root file yields one TreeFile with correct name and path", () => {
    const tree = buildFileTree([makeFile("README.md")]);
    expect(tree).toHaveLength(1);
    const file = asFile(tree[0]);
    expect(file.name).toBe("README.md");
    expect(file.path).toBe("README.md");
    expect(file.status).toBe("modified");
  });

  test("directories before files, alphabetical within each group", () => {
    const tree = buildFileTree([
      makeFile("src/b.ts"),
      makeFile("src/a/x.ts"),
      makeFile("docs/r.md"),
      makeFile("README.md"),
    ]);
    expect(tree.map((n) => n.type)).toEqual(["dir", "dir", "file"]);
    const docs = asDir(tree[0]);
    const src = asDir(tree[1]);
    expect(docs.name).toBe("docs");
    expect(src.name).toBe("src");
    expect(asFile(tree[2]).name).toBe("README.md");
    // src children: dir "a" strictly before file "b.ts"
    expect(src.children.map((n) => [n.type, n.name])).toEqual([
      ["dir", "a"],
      ["file", "b.ts"],
    ]);
  });

  test("sorting is case-insensitive and numeric-aware", () => {
    const tree = buildFileTree([
      makeFile("src/file10.ts"),
      makeFile("src/File2.ts"),
      makeFile("src/apple.ts"),
      makeFile("src/Banana.ts"),
    ]);
    const src = asDir(tree[0]);
    expect(src.children.map((n) => n.name)).toEqual([
      "apple.ts",
      "Banana.ts",
      "File2.ts",
      "file10.ts",
    ]);
  });

  test("compresses single-dir chains at root level", () => {
    const tree = buildFileTree([makeFile("a/b/c/file.ts")]);
    expect(tree).toHaveLength(1);
    const dir = asDir(tree[0]);
    expect(dir.name).toBe("a/b/c");
    expect(dir.path).toBe("a/b/c");
    expect(dir.children).toHaveLength(1);
    expect(asFile(dir.children[0]).name).toBe("file.ts");
  });

  test("compression stops at branching", () => {
    const tree = buildFileTree([makeFile("src/components/A.tsx"), makeFile("src/lib/b.ts")]);
    expect(tree).toHaveLength(1);
    const src = asDir(tree[0]);
    expect(src.name).toBe("src");
    expect(src.children.map((n) => [n.type, n.name])).toEqual([
      ["dir", "components"],
      ["dir", "lib"],
    ]);
  });

  test("no compression past a dir owning a file; single-file dirs never merge", () => {
    const tree = buildFileTree([makeFile("src/index.ts"), makeFile("src/lib/util.ts")]);
    expect(tree).toHaveLength(1);
    const src = asDir(tree[0]);
    expect(src.name).toBe("src");
    expect(src.children.map((n) => [n.type, n.name])).toEqual([
      ["dir", "lib"],
      ["file", "index.ts"],
    ]);
    const lib = asDir(src.children[0]);
    expect(lib.children.map((n) => n.name)).toEqual(["util.ts"]);
  });

  test("renamed file is placed under newPath with oldPath preserved", () => {
    const tree = buildFileTree([
      makeFile("src/renamed.ts", { oldPath: "src/original.ts", isRenamed: true }),
    ]);
    const src = asDir(tree[0]);
    const file = asFile(src.children[0]);
    expect(file.path).toBe("src/renamed.ts");
    expect(file.oldPath).toBe("src/original.ts");
    expect(file.status).toBe("renamed");
  });

  test("duplicate newPath keeps the first occurrence only", () => {
    const tree = buildFileTree([
      makeFile("src/index.ts", { isNew: true }),
      makeFile("src/index.ts", { isDeleted: true }),
    ]);
    const src = asDir(tree[0]);
    expect(src.children).toHaveLength(1);
    expect(asFile(src.children[0]).status).toBe("added");
  });

  test("odd path segments normalize (leading/double slashes)", () => {
    const tree = buildFileTree([makeFile("/src//x.ts")]);
    expect(tree).toHaveLength(1);
    const src = asDir(tree[0]);
    expect(src.name).toBe("src");
    expect(src.path).toBe("src");
    const file = asFile(src.children[0]);
    expect(file.name).toBe("x.ts");
    // path stays the original newPath — the anchor key used in the DOM
    expect(file.path).toBe("/src//x.ts");
  });

  test("rebuild after filter re-compresses chains", () => {
    const files = [makeFile("src/components/A.tsx"), makeFile("src/lib/b.ts")];
    const tree = buildFileTree(filterFiles(files, "components"));
    expect(tree).toHaveLength(1);
    const dir = asDir(tree[0]);
    expect(dir.name).toBe("src/components");
    expect(dir.path).toBe("src/components");
    expect(asFile(dir.children[0]).name).toBe("A.tsx");
  });

  test("file-to-directory conversion yields sibling dir and file nodes sharing a path", () => {
    // git rm config + add config/default.json: sibling nodes both have
    // path "config" but different types (React keys are type-namespaced).
    const tree = buildFileTree([
      makeFile("config", { isDeleted: true }),
      makeFile("config/default.json", { isNew: true }),
    ]);
    expect(tree).toHaveLength(2);
    const dir = asDir(tree[0]);
    expect(dir.path).toBe("config");
    expect(asFile(dir.children[0]).path).toBe("config/default.json");
    const file = asFile(tree[1]);
    expect(file.path).toBe("config");
    expect(file.status).toBe("deleted");
  });
});

describe("orderFilesByTree", () => {
  test("reorders diff files to the tree's depth-first display order", () => {
    // git diff order: alphabetical by full path
    const files = [
      makeFile("README.md"),
      makeFile("src/App.tsx"),
      makeFile("src/lib/util.ts"),
      makeFile("src/components/A.tsx"),
    ];
    // tree order: dirs before files at every level
    expect(orderFilesByTree(files).map((f) => f.newPath)).toEqual([
      "src/components/A.tsx",
      "src/lib/util.ts",
      "src/App.tsx",
      "README.md",
    ]);
  });

  test("duplicate newPaths keep their input order after the shared rank", () => {
    const first = makeFile("src/index.ts", { isDeleted: true });
    const second = makeFile("src/index.ts", { isNew: true });
    const ordered = orderFilesByTree([makeFile("docs/readme.md"), first, second]);
    expect(ordered[0]?.newPath).toBe("docs/readme.md");
    expect(ordered[1]).toBe(first);
    expect(ordered[2]).toBe(second);
  });

  test("empty input returns empty output", () => {
    expect(orderFilesByTree([])).toEqual([]);
  });
});

describe("fileStatus", () => {
  test("precedence matches DiffFile badge: isNew > isDeleted > isRenamed > modified", () => {
    expect(fileStatus({ isNew: true, isDeleted: true, isRenamed: true })).toBe("added");
    expect(fileStatus({ isNew: false, isDeleted: true, isRenamed: true })).toBe("deleted");
    expect(fileStatus({ isNew: false, isDeleted: false, isRenamed: true })).toBe("renamed");
    expect(fileStatus({ isNew: false, isDeleted: false, isRenamed: false })).toBe("modified");
  });
});

describe("fileCounts", () => {
  test("sums adds and deletes across multiple hunks, ignoring context lines", () => {
    const file = makeFile("src/index.ts", {
      hunks: [
        makeHunk(["add", "add", "context", "delete"]),
        makeHunk(["context", "delete", "add", "header"]),
      ],
    });
    expect(fileCounts(file)).toEqual({ additions: 3, deletions: 2 });
  });

  test("pure rename with zero hunks counts +0/-0", () => {
    const file = makeFile("src/renamed.ts", { oldPath: "src/original.ts", isRenamed: true });
    expect(fileCounts(file)).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("filterFiles", () => {
  const files = [
    makeFile("src/components/A.tsx"),
    makeFile("src/lib/b.ts"),
    makeFile("docs/readme.md"),
  ];

  test("case-insensitive substring match on full path", () => {
    const result = filterFiles(files, "COMPONENTS");
    expect(result.map((f) => f.newPath)).toEqual(["src/components/A.tsx"]);
  });

  test("whitespace-only query returns all files unchanged", () => {
    expect(filterFiles(files, "   ")).toEqual(files);
    expect(filterFiles(files, "")).toEqual(files);
  });

  test("no match returns empty array", () => {
    expect(filterFiles(files, "does-not-exist")).toEqual([]);
  });
});

describe("visibleDiffFiles", () => {
  test("drops generated files", () => {
    const diff = [
      makeFile("src/index.ts"),
      makeFile("bun.lock", { generated: true }),
      makeFile("docs/readme.md"),
    ];
    expect(visibleDiffFiles(diff).map((f) => f.newPath)).toEqual([
      "src/index.ts",
      "docs/readme.md",
    ]);
  });
});
