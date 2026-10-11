import { describe, expect, it } from "bun:test";
import { parseDiff } from "./diff.ts";

describe("a unified diff", () => {
  it("reads each file's hunks, with the old and new line numbers, and its counts", () => {
    const text = [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -12,3 +12,4 @@ ## Getting started",
      " one",
      "-two",
      "+2",
      "+three",
      " four",
      "\\ No newline at end of file",
      "diff --git a/docs/new file.md b/docs/new file.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/new file.md",
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");
    const files = parseDiff(text);
    expect(files.map((file) => [file.path, file.added, file.removed, file.binary])).toEqual([
      ["README.md", 2, 1, false], ["docs/new file.md", 1, 0, false], ["gone.txt", 0, 1, false], ["logo.png", 0, 0, true], ["new.ts", 0, 0, false],
    ]);
    expect(files[0]!.lines).toEqual([
      { kind: "hunk", text: "@@ -12,3 +12,4 @@ ## Getting started" },
      { kind: "ctx", old: 12, new: 12, text: "one" },
      { kind: "del", old: 13, text: "two" },
      { kind: "add", new: 13, text: "2" },
      { kind: "add", new: 14, text: "three" },
      { kind: "ctx", old: 14, new: 15, text: "four" },
    ]);
    expect(files[2]!.lines[1]).toEqual({ kind: "del", old: 1, text: "bye" });
    expect(files[4]!.from).toBe("old.ts");
    expect(parseDiff("")).toEqual([]);
  });

  it("keeps a line that looks like a header inside a hunk", () => {
    const files = parseDiff(["diff --git a/a.md b/a.md", "--- a/a.md", "+++ b/a.md", "@@ -1,2 +1,2 @@", "---- a/x", "++++ b/x"].join("\n"));
    expect(files[0]!.lines.slice(1)).toEqual([{ kind: "del", old: 1, text: "--- a/x" }, { kind: "add", new: 1, text: "+++ b/x" }]);
  });
});
