import { describe, expect, it } from "bun:test";
import type { PaneInfo, TabInfo } from "../shared/herdr-api.generated.ts";
import { openSideTerminal } from "./side-terminal.ts";

const pane = (id: string, extra: Partial<PaneInfo> = {}): PaneInfo => ({
  pane_id: id, workspace_id: "w1", tab_id: "w1:t1", terminal_id: `t-${id}`, focused: false, agent_status: "idle", revision: 1, cwd: "/repo/wt", agent: "claude", ...extra,
});
const tab = (id: string, label: string): TabInfo => ({ tab_id: id, workspace_id: "w1", label, number: 1, pane_count: 1, focused: false, agent_status: "unknown" });

function herdr(panes: PaneInfo[], tabs: TabInfo[]) {
  const created: Array<{ workspaceId: string; cwd: string | undefined; label: string }> = [];
  return {
    created,
    deps: {
      snapshot: async () => ({ panes, tabs }),
      // as herdr does: the new tab and its shell are in the next snapshot
      createTab: async (workspaceId: string, cwd: string | undefined, label: string) => {
        created.push({ workspaceId, cwd, label });
        await Promise.resolve();
        const shell = pane(`w1:p${10 + created.length}`, { tab_id: `w1:t${10 + created.length}`, agent: null });
        tabs.push(tab(shell.tab_id, label));
        panes.push(shell);
        return shell;
      },
    },
  };
}

describe("a pane's terminal for the side panel", () => {
  it("opens a tab labelled terminal in the pane's workspace, its shell in the pane's folder", async () => {
    const { created, deps } = herdr([pane("w1:p1")], [tab("w1:t1", "lead")]);
    expect(await openSideTerminal("w1:p1", deps)).toBe("w1:p11");
    expect(created).toEqual([{ workspaceId: "w1", cwd: "/repo/wt", label: "terminal" }]);
  });

  it("uses the workspace's terminal already there", async () => {
    const { created, deps } = herdr([pane("w1:p1"), pane("w1:p2", { tab_id: "w1:t2", agent: null })], [tab("w1:t1", "lead"), tab("w1:t2", "terminal")]);
    expect(await openSideTerminal("w1:p1", deps)).toBe("w1:p2");
    expect(created).toEqual([]);
  });

  it("opens one for two asks at once", async () => {
    const { created, deps } = herdr([pane("w1:p1"), pane("w1:p3")], []);
    expect(await Promise.all([openSideTerminal("w1:p1", deps), openSideTerminal("w1:p3", deps)])).toEqual(["w1:p11", "w1:p11"]);
    expect(created).toHaveLength(1);
  });

  it("says a pane herdr does not know", async () => {
    await expect(openSideTerminal("w1:p7", herdr([], []).deps)).rejects.toMatchObject({ code: "pane_not_found" });
  });
});
