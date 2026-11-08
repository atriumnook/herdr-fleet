import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { herdrRpc, paneRead, paneSendKeys, paneSendText, tabCreate, workspaceClose, workspaceCreate } from "../../server/herdr/client.ts";
import { TEST_SESSION, testShellStartup } from "../test-herdr.ts";

/**
 * The panes of the test herdr read their zsh startup files from the tests' own folder, not from the
 * person's (#179), however the pane is made: the test herdr's server hands ZDOTDIR to every shell it
 * starts (scripts/test-herdr.ts), so a test or a server under test needs to pass nothing. The value is
 * read once the shell has run its startup files, so a system zshenv that sets ZDOTDIR again shows too.
 */
async function shellStartupOf(paneId: string): Promise<string> {
  // the typed line holds "zdotdir-$(", never the answer, so only the shell's output can match
  const quoted = `'${testShellStartup().replaceAll("'", `'\\''`)}'`;
  await paneSendText(paneId, `echo zdotdir-$([ "$ZDOTDIR" = ${quoted} ] && echo ours || echo other)`);
  await paneSendKeys(paneId, ["Enter"]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const answer = (await paneRead({ paneId, lines: 40 })).text.match(/^zdotdir-(ours|other)\b/m);
    if (answer) return answer[1]!;
    await Bun.sleep(100);
  }
  return "no answer";
}

it("starts every pane's shell with the tests' own zsh startup folder", async () => {
  expect(readFileSync(`${testShellStartup()}/.zshrc`, "utf8")).toBe("");
  const created = await workspaceCreate({ cwd: tmpdir(), label: "herdr-fleet-test-shell" });
  try {
    const split = await herdrRpc<{ pane: { pane_id: string } }>("pane.split", { target_pane_id: created.root_pane.pane_id, direction: "down", focus: false });
    const tab = await tabCreate({ workspaceId: created.workspace.workspace_id, cwd: tmpdir(), label: "herdr-fleet-test-shell-tab" });
    if (!tab) throw new Error("tab.create returned no root pane");
    const panes = { workspace: created.root_pane.pane_id, split: split.pane.pane_id, tab: tab.pane_id };
    const found = Object.fromEntries(await Promise.all(Object.entries(panes).map(async ([made, paneId]) => [made, await shellStartupOf(paneId)])));
    expect(found, `the panes of the test herdr session "${TEST_SESSION}" do not start from ${testShellStartup()}`).toEqual({ workspace: "ours", split: "ours", tab: "ours" });
  } finally {
    await workspaceClose(created.workspace.workspace_id);
  }
}, 40_000);
