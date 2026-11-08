import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { herdrRpc, paneRead, paneSendKeys, paneSendText, tabCreate, workspaceClose, workspaceCreate } from "../../server/herdr/client.ts";
import { TEST_SESSION, testShellStartup } from "../test-herdr.ts";

/**
 * The panes of the test herdr read their zsh startup files from the tests' own folder, not from the
 * person's (#179), however the pane is made: the test herdr's server hands ZDOTDIR to every shell it
 * starts (scripts/test-herdr.ts), so a test or a server under test needs to pass nothing.
 */
async function shellStartupOf(paneId: string): Promise<string> {
  // the typed line holds "zdotdir-$(", never the answer, so only the shell's output can match
  await paneSendText(paneId, `echo zdotdir-$([ "$ZDOTDIR" = '${testShellStartup()}' ] && echo ours || echo other)`);
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
    const panes = { workspace: created.root_pane.pane_id, split: split.pane.pane_id, tab: tab!.pane_id };
    const found = Object.fromEntries(await Promise.all(Object.entries(panes).map(async ([made, paneId]) => [made, await shellStartupOf(paneId)])));
    // "other" or "no answer" in all three: a server of this session started before ZDOTDIR was set; stop it once
    expect(found, `herdr --session ${TEST_SESSION} server stop, if its server was started without ZDOTDIR`).toEqual({ workspace: "ours", split: "ours", tab: "ours" });
  } finally {
    await workspaceClose(created.workspace.workspace_id);
  }
}, 40_000);
