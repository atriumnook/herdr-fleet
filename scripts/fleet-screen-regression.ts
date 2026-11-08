import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { createServer } from "../server/index.ts";
import { DEFAULT_CONFIG } from "../server/fleet/config.ts";
import type { AgentRuntime } from "../server/fleet/runtime.ts";
import type { AgentRun, AgentState } from "../server/fleet/types.ts";
import { UsageTracker } from "../server/fleet/usage.ts";

/** what each thread's lead has committed on its branch, by the thread's title */
const CHANGES: Record<string, { file: string; text: string }> = {
  "Update the README": { file: "README.md", text: "# repo\n\nInstall the dependencies without their lifecycle scripts:\n\n    bun install --ignore-scripts\n\nThen start the server: bun run start\n" },
  "Fix the retry": { file: "src/retry.ts", text: "export const RETRIES = 3;\n\nexport function shouldRetry(attempt: number): boolean {\n  return attempt < RETRIES;\n}\n" },
};

/** what each agent of the stand-in fleet does, by the name it was started with */
const BEHAVIOUR: Record<string, AgentState> = {
  "repo · fleet": "idle", "Fix the retry": "blocked", "Update the README": "idle", "Weekly usage window": "working", review: "idle", bench: "working",
  "Limit the retries": "idle",
};

/** the plan the "Limit the retries" lead hands over: a decision, lines of its worktree, and code it proposes */
const PLAN = {
  title: "Retry limit in the README",
  why: ["say how many times a send is tried"],
  claims: [
    {
      text: "The README says a failed send is tried three times.",
      ask: { id: "limit", question: "How many tries should the README promise?", options: [{ value: "three", label: "3 tries" }, { value: "five", label: "5 tries", note: "claim 1.1 changes" }], recommended: "three" },
      children: [{ text: "README.md:1 · the title", exhibit: { kind: "code", path: "README.md", start: 1, end: 1 } }],
    },
    { text: "The limit is one constant.", exhibit: { kind: "code", path: "src/limit.ts", text: "export const RETRIES = 3;" } },
  ],
  scope: ["The retry code itself"],
};

/**
 * The Fleet screen in a real browser, over a server whose fleet runs on a stand-in runtime (no
 * agent CLI starts) in real herdr panes: the project list, the project conversation, the Overview
 * with the threads by what they ask of the person, a thread opened beside it and large, one of its
 * helpers, its change with a comment waiting, its checks and the yes a discard asks for, a thread
 * marked done, the Settings page writing fleet.json and putting the fleet skill into a skill folder
 * (folders of its own, never the person's), and
 * on a phone the Overview as a sheet, a thread with its change on the whole screen and the Settings
 * page. With FLEET_SCREENSHOTS set to a folder, it saves what it saw there.
 */
export async function checkFleetScreen(browser: Browser): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-fleet-screen-"));
  const shots = process.env["FLEET_SCREENSHOTS"];
  const workspaces: string[] = [];
  let server: ReturnType<typeof createServer> | undefined;
  try {
    // the project: a repository with one commit, which the threads' change is measured against
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-C", repo, ...args]);
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "# repo\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "start");

    // every agent the screen opens sits in a real pane, so its chat reads something
    const paneFor = new Map<string, string>();
    const realPane = async (label: string) => {
      const created = await workspaceCreate({ cwd: repo, label: `herdr-fleet-test-${label.replace(/\W+/g, "-")}` });
      workspaces.push(created.workspace.workspace_id);
      return created.root_pane.pane_id;
    };
    const labelOf = new Map<string, string>();
    const stateOf = new Map<string, AgentState>();
    let fakes = 0;
    const runtime: AgentRuntime = {
      createLocation: async (options) => {
        const paneId = options.label === "bench" ? `w99:p${++fakes}` : await realPane(options.label);
        labelOf.set(paneId, options.label);
        paneFor.set(options.label, paneId);
        // a thread's worktree on its branch, as herdr makes it, with what its lead committed there
        if (!options.worktree || !options.path || !options.branch) return { paneId, cwd: options.cwd };
        git("worktree", "add", "-q", "-b", options.branch, options.path);
        const change = CHANGES[options.label];
        if (change) {
          mkdirSync(join(options.path, change.file, ".."), { recursive: true });
          writeFileSync(join(options.path, change.file), change.text);
          Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-C", options.path, "add", "."]);
          Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-C", options.path, "commit", "-q", "-m", options.label]);
        }
        return { paneId, cwd: options.path };
      },
      start: async (options) => {
        const state = BEHAVIOUR[labelOf.get(options.paneId) ?? ""] ?? "working";
        stateOf.set(options.name, state);
        return state === "blocked" ? "blocked" : "idle";
      },
      prompt: async (name) => stateOf.get(name) ?? "working",
      get: async (name) => stateOf.get(name) ?? "working",
      read: async () => "", screen: async () => "",
      closePane: async () => {}, interrupt: async () => {}, focus: async () => {}, reportMetadata: async () => {},
    };
    const now = Date.now();
    const usage = new UsageTracker({ file: null });
    usage.record("claude", { readAt: now, windows: [{ name: "5h", usedPercent: 42, resetsAt: now + 3_600_000 }, { name: "weekly", usedPercent: 28, resetsAt: now + 86_400_000 }] });
    usage.record("codex", { readAt: now, windows: [{ name: "5h", usedPercent: 92, resetsAt: now + 3_600_000 }, { name: "weekly", usedPercent: 64, resetsAt: now + 86_400_000 }] });
    const stateDir = join(root, "state");
    // a skill of the person's own where agy reads skills: the fleet must leave it alone
    const ownSkill = join(root, "home", ".gemini", "config", "skills", "herdr-fleet", "SKILL.md");
    mkdirSync(join(ownSkill, ".."), { recursive: true });
    writeFileSync(ownSkill, "---\nname: herdr-fleet\ndescription: my own\n---\n");
    server = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir,
      fleet: {
        runtime, usage, userDir: join(root, "config"), homeDir: join(root, "home"),
        // the CLIs' own lists stand in: nothing here runs claude or codex
        models: { unknown: async () => undefined, listAll: async () => [
          { agent: "claude", models: [{ id: "opus" }, { id: "sonnet" }], complete: false },
          { agent: "codex", models: [{ id: "gpt-6", label: "GPT-6" }], complete: true },
        ] },
        config: () => ({ ...DEFAULT_CONFIG, closeOnSettle: false }),
        agents: () => [
          { name: "coordinator", description: "coordinates", agent: "claude", interactive: true, spawning: true, edits: false, systemPrompt: "", source: "bundled", filePath: "" },
          { name: "lead", description: "leads", agent: "claude", interactive: true, spawning: true, systemPrompt: "", source: "bundled", filePath: "" },
          { name: "reviewer", description: "reviews", agent: "cursor", systemPrompt: "", source: "bundled", filePath: "" },
          { name: "worker", description: "implements", agent: "pi", systemPrompt: "", source: "bundled", filePath: "" },
        ],
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const post = async (path: string, body: unknown): Promise<AgentRun> => {
      const response = await fetch(`${origin}/api/fleet${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-fleet": "1" }, body: JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text());
      return ((await response.json()) as { run: AgentRun }).run;
    };
    const coordinator = await post("/projects", { task: "Fix the retry, update the README and show the weekly usage window", cwd: repo });
    const thread = (title: string) => post("/threads", { title, task: "t", cwd: repo, caller_run: coordinator.id });
    await thread("Fix the retry");
    const readme = await thread("Update the README");
    // the README's lead reports ready, with a contract, read once its turn settles
    writeFileSync(join(stateDir, "fleet-results", readme.id, "handoff.md"), "## HANDOFF\nPASS — the steps start the server (bun run start)\n");
    writeFileSync(join(stateDir, "fleet-results", readme.id, "report.json"), JSON.stringify({ state: "ready", summary: "the steps start the server (bun run start)", evidence: ["bun run start"] }));
    writeFileSync(join(stateDir, "fleet-results", readme.id, "contract.md"), "- [x] A1 steps run — evidence: started\n- [x] A2 reviewed — evidence: no findings\n");
    await thread("Weekly usage window");
    await post("/spawn", { role: "reviewer", name: "review", task: "t", cwd: repo, group: readme.group });
    const bench = await post("/spawn", { role: "worker", name: "bench", task: "t", cwd: root, group: "fleet-bench" });

    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    await desktop.addInitScript(() => localStorage.setItem("herdr-fleet:settings", JSON.stringify({})));
    const page = await desktop.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.locator(".conn-live").waitFor();

    await page.locator(".fleet-button").click();
    const screen = page.locator(".fleet-screen");
    await screen.waitFor();
    // the sidebar lists the projects; the conversation is the coordinator's
    await page.locator(".fleet-project.is-selected", { hasText: "repo" }).waitFor();
    assert.match(await screen.locator(".fleet-main-meta").textContent() ?? "", /coordinator · claude/);
    await screen.locator(".fleet-main .fleet-chat").waitFor();
    // the Overview: what waits on the person first, the README's PASS once its turn settled
    await screen.locator("#fleet-group-review").waitFor();
    const groups = await screen.locator(".fleet-overview-body h3").allTextContents();
    assert.deepEqual(groups.map((group) => group.replace(/\s*\d+$/, "")), ["Needs you", "Ready for review", "Working"]);
    assert.match(await screen.locator(".fleet-row.group-needs").textContent() ?? "", /Fix the retry/);
    assert.equal(await screen.locator(".fleet-overview-button .fleet-needs-dot").count(), 1);
    await save(page, shots, "fleet-desktop-dark");

    // a thread opens beside the conversation, with its helper
    await screen.locator(".fleet-row", { hasText: "Update the README" }).click();
    const open = screen.locator(".fleet-overview .fleet-open");
    await open.waitFor();
    assert.match(await open.locator(".fleet-open-title").textContent() ?? "", /Update the README/);
    assert.match(await open.locator(".fleet-contract").textContent() ?? "", /A1 ✓/);
    await open.locator(".fleet-overview .fleet-chat, .fleet-chat").first().waitFor();
    // the chat beside reads its pane's conversation, as the pane's own chat does
    await open.locator(".fleet-chat .chat-terminal-fallback, .fleet-chat .chat-empty").first().waitFor();
    // a click in it gives it the focus, so the prompt steps (Mod+Shift+[ and ]) go to it
    await open.locator(".fleet-chat .chat-view").first().click({ position: { x: 4, y: 4 } });
    assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-chat-lens="side"]') != null), true, "a click in the chat beside gives it the focus");
    await screen.locator(".fleet-main .fleet-chat .chat-view").click({ position: { x: 4, y: 4 } });
    assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-chat-lens="main"]') != null), true, "a click in the conversation gives it the focus");
    await open.locator(".fleet-member", { hasText: "review · cursor" }).click();
    await open.locator(".fleet-member.is-selected", { hasText: "review" }).waitFor();
    await open.locator(".fleet-chat .chat-terminal-fallback, .fleet-chat .chat-empty").first().waitFor();
    await save(page, shots, "fleet-thread-dark");

    // large in the middle, the Overview listing the threads again with this one marked
    await open.getByRole("button", { name: "Expand" }).click();
    await screen.locator(".fleet-main .fleet-open.is-large").waitFor();
    await screen.locator(".fleet-row.is-selected", { hasText: "Update the README" }).waitFor();
    await save(page, shots, "fleet-expanded-dark");

    // its change: a line takes a comment, which waits until it goes to the lead with the others
    const large = screen.locator(".fleet-main .fleet-open.is-large");
    for (const step of ["Discard", "Merge into main", "Create PR"]) await large.getByRole("button", { name: step, exact: true }).waitFor();
    await large.getByRole("button", { name: "Changes", exact: true }).click();
    await large.locator(".fleet-file.is-on", { hasText: "README.md" }).waitFor();
    await large.locator(".fleet-line.is-add").nth(2).click();
    await large.getByRole("textbox", { name: "Comment for the lead" }).fill("Keep bun dev for working on the UI");
    await large.getByRole("button", { name: "Add comment" }).click();
    await large.locator(".fleet-line-comment", { hasText: "Keep bun dev" }).waitFor();
    assert.match(await large.locator(".fleet-comment-queue").textContent() ?? "", /1 comment for the lead/);
    await save(page, shots, "fleet-changes-dark");
    // its checks: committed, up to date, the contract and the review; no GitHub remote to ask
    await large.getByRole("button", { name: /^Checks/ }).click();
    await large.locator(".fleet-check", { hasText: "All work committed" }).waitFor();
    await large.locator(".fleet-check", { hasText: "Up to date with main" }).waitFor();
    await large.locator(".fleet-check", { hasText: "Reviewed on another CLI" }).waitFor();
    await large.locator(".fleet-check", { hasText: "1 comment not sent" }).waitFor();
    await save(page, shots, "fleet-checks-dark");
    // a discard asks first, and says what goes
    await large.getByRole("button", { name: "Discard", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "Discard this thread?" });
    await dialog.waitFor();
    assert.match(await dialog.textContent() ?? "", /ブランチ fleet\/\w+ を、その 1 個のコミットごと消します/);
    await save(page, shots, "fleet-discard-dark");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    await large.getByRole("button", { name: "Chat", exact: true }).click();
    await screen.locator(".fleet-main").getByRole("button", { name: "Collapse" }).click();
    await screen.locator(".fleet-overview .fleet-open").waitFor();

    // marked done, it folds under Resolved
    await screen.locator(".fleet-overview .fleet-open").getByRole("button", { name: "Resolve" }).click();
    await screen.locator(".fleet-overview .fleet-open").getByRole("button", { name: "Reopen" }).waitFor();
    await screen.locator(".fleet-overview").getByRole("button", { name: "Back to threads" }).click();
    await screen.locator(".fleet-fold", { hasText: "Resolved 1" }).waitFor();

    // a lead hands over a plan: the thread waits on the person, who answers it in the Plan tab
    const limit = await thread("Limit the retries");
    const planned = await fetch(`${origin}/api/fleet/runs/${limit.id}/plan`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-fleet": "1" }, body: JSON.stringify({ plan: PLAN }) });
    assert.equal(planned.status, 201, await planned.clone().text());
    // and ends its turn with a blocked report, as agents/lead.md has it
    writeFileSync(join(stateDir, "fleet-results", limit.id, "handoff.md"), "## HANDOFF\nBLOCKED — the plan waits for the person on the Fleet screen\n");
    writeFileSync(join(stateDir, "fleet-results", limit.id, "report.json"), JSON.stringify({ state: "blocked", summary: "the plan waits for the person on the Fleet screen", evidence: ["fleet plan"] }));
    await screen.locator(".fleet-row.group-needs", { hasText: "Limit the retries" }).locator(".fleet-plan-chip", { hasText: "Plan · 1 to answer" }).waitFor();
    await screen.locator(".fleet-row", { hasText: "Limit the retries" }).click();
    const planOpen = screen.locator(".fleet-overview .fleet-open");
    await planOpen.getByRole("button", { name: /^Plan/ }).click();
    const planView = planOpen.locator(".fleet-plan");
    await planView.locator(".fleet-plan-head", { hasText: "Retry limit in the README" }).waitFor();
    // closed, the tree is the summary: the first-level claims only
    assert.equal(await planView.locator(".fleet-plan-claim.level-1").count(), 2);
    assert.equal(await planView.locator(".fleet-plan-claim.level-2").first().isVisible(), false);
    await save(page, shots, "fleet-plan-dark");
    // "1 to answer" opens the decision; the lines come from the thread's worktree
    await planView.getByRole("button", { name: "1 to answer" }).click();
    await planView.getByRole("radio", { name: /5 tries/ }).click();
    await planView.locator(".fleet-plan-claim.level-2 summary").click();
    assert.match(await planView.locator(".fleet-plan-code").first().textContent() ?? "", /# repo/);
    await planView.locator(".fleet-plan-claim.level-1").first().locator(".fleet-plan-comment-button").first().click();
    await planView.getByRole("textbox", { name: "Comment on 1" }).fill("Say it in the install section");
    await save(page, shots, "fleet-plan-answered-dark");
    // Respond asks first, then the answers go to the lead, and the plan shows them sent
    await planView.getByRole("button", { name: "Respond" }).and(page.locator(":enabled")).click();
    const respond = page.getByRole("alertdialog", { name: "Send your answers to the lead?" });
    await respond.waitFor();
    assert.match(await respond.textContent() ?? "", /D1 How many tries should the README promise\? → 5 tries/);
    await save(page, shots, "fleet-plan-confirm-dark");
    await respond.getByRole("button", { name: "Send answers" }).click();
    await planView.locator(".fleet-plan-done", { hasText: "Answered" }).waitFor();
    const answered = await (await fetch(`${origin}/api/fleet/runs/${limit.id}/plan`)).json() as { plan: { answer: { choices: Record<string, string>; comments: unknown[] } } };
    assert.deepEqual(answered.plan.answer.choices, { limit: "five" });
    assert.deepEqual(answered.plan.answer.comments, [{ claim: "1", text: "Say it in the install section" }]);
    await planOpen.getByRole("button", { name: "Back to threads" }).click();

    // the Settings page: a candidate added to the lead is written to fleet.json, and codex, 92% used, is passed over
    const settingsFile = join(root, "config", "fleet.json");
    await page.locator(".fleet-rail-settings").click();
    const settingsPage = screen.locator(".fleet-settings");
    await settingsPage.locator(".fleet-role", { hasText: "lead" }).waitFor();
    await settingsPage.locator(".fleet-role-head", { hasText: "lead" }).click();
    await settingsPage.getByRole("button", { name: "Add candidate" }).click();
    await settingsPage.locator(".fleet-role.is-open .fleet-candidate.is-skipped", { hasText: "codex" }).waitFor();
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).roles.lead, { agent: "claude", model: "claude:", fallbackModels: ["codex:"] });
    assert.match(await settingsPage.locator(".fleet-role.is-open .fleet-role-now").textContent() ?? "", /Now: claude/);
    // a model field offers its CLI's own models, and flags a name a complete list lacks
    const claudeModel = settingsPage.getByRole("combobox", { name: "Model of candidate 1" });
    const codexModel = settingsPage.getByRole("combobox", { name: "Model of candidate 2" });
    const offered = (field: typeof claudeModel) => field.evaluate((input: HTMLInputElement) => [...(input.list?.options ?? [])].map((option) => option.value));
    assert.deepEqual(await offered(claudeModel), ["opus", "sonnet"]);
    assert.deepEqual(await offered(codexModel), ["gpt-6"]);
    await codexModel.fill("gpt-9");
    await codexModel.press("Enter");
    // (the page is in Japanese here: sentences are translated)
    await settingsPage.locator(".fleet-role.is-open .fleet-candidate-hint.is-skipped", { hasText: "codex にこのモデルはありません。" }).waitFor();
    await codexModel.fill("gpt-6");
    await codexModel.press("Enter");
    await settingsPage.locator(".fleet-role.is-open .fleet-candidate-hint", { hasText: "このモデルはありません" }).waitFor({ state: "detached" });
    await codexModel.fill("");
    await codexModel.press("Enter");
    await save(page, shots, "fleet-settings-dark");
    // no conversation is open on the Settings page: the prompt steps' keys are left alone
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      const seen = { prevented: null as boolean | null };
      (window as unknown as { stepKey: typeof seen }).stepKey = seen;
      window.addEventListener("keydown", (event) => { if (event.code === "BracketLeft") seen.prevented = event.defaultPrevented; });
    });
    await page.keyboard.press("Control+Shift+BracketLeft");
    assert.equal(await page.evaluate(() => (window as unknown as { stepKey: { prevented: boolean | null } }).stepKey.prevented), false, "no prompt to step to with no conversation open");
    await settingsPage.getByRole("button", { name: "Projects", exact: true }).click();
    const setup = settingsPage.getByRole("textbox", { name: "Setup command for repo" });
    await setup.fill("bun install --ignore-scripts");
    await setup.press("Enter");
    for (let tries = 0; !readFileSync(settingsFile, "utf8").includes("ignore-scripts"); tries++) {
      assert.ok(tries < 50, "the setup command reaches fleet.json");
      await Bun.sleep(100);
    }
    assert.equal(JSON.parse(readFileSync(settingsFile, "utf8")).projects[repo].setup, "bun install --ignore-scripts");
    // the project's merge authority: Gated on a branch reaches fleet.json beside the setup command, and Person takes it out again
    const merges = settingsPage.getByRole("group", { name: "Merges for repo" });
    await merges.getByRole("button", { name: "Gated", exact: true }).click();
    const branches = merges.getByRole("textbox", { name: "Branches" });
    await branches.fill("staging");
    await branches.press("Enter");
    const projectEntry = () => JSON.parse(readFileSync(settingsFile, "utf8")).projects[repo];
    for (let tries = 0; JSON.stringify(projectEntry().merge?.branches) !== '["staging"]'; tries++) {
      assert.ok(tries < 50, "the gated branches reach fleet.json");
      await Bun.sleep(100);
    }
    assert.deepEqual(projectEntry(), { setup: "bun install --ignore-scripts", merge: { mode: "gated", branches: ["staging"], maxLines: 200, protected: [] } });
    await save(page, shots, "fleet-settings-projects-dark");
    await merges.getByRole("button", { name: "Person", exact: true }).click();
    for (let tries = 0; projectEntry().merge !== undefined; tries++) {
      assert.ok(tries < 50, "Person takes the merge setting out of fleet.json");
      await Bun.sleep(100);
    }
    // Language: the language the person reads reaches fleet.json, and every agent started after it is told
    await settingsPage.getByRole("button", { name: "Language", exact: true }).click();
    const language = settingsPage.getByRole("textbox", { name: "Language you read" });
    await language.fill("Japanese");
    await language.press("Enter");
    for (let tries = 0; JSON.parse(readFileSync(settingsFile, "utf8")).language !== "Japanese"; tries++) {
      assert.ok(tries < 50, "the language reaches fleet.json");
      await Bun.sleep(100);
    }
    await save(page, shots, "fleet-settings-language-dark");
    await settingsPage.getByRole("button", { name: "Usage", exact: true }).click();
    await settingsPage.locator(".fleet-account.is-skipped", { hasText: "codex" }).waitFor();
    await save(page, shots, "fleet-settings-usage-dark");
    // Entrances: Install puts the fleet skill where pi, codex and cursor read skills; the person's own file stays
    await settingsPage.getByRole("button", { name: "Entrances", exact: true }).click();
    const agentsRow = settingsPage.locator(".fleet-setting-entrance", { hasText: "/.agents/skills/herdr-fleet/SKILL.md" });
    await agentsRow.getByRole("button", { name: "Install" }).click();
    await agentsRow.locator(".fleet-entrance-installed").waitFor();
    assert.match(readFileSync(join(root, "home", ".agents", "skills", "herdr-fleet", "SKILL.md"), "utf8"), /fleet\.ts guide\n/);
    const takenRow = settingsPage.locator(".fleet-setting-entrance", { hasText: "/.gemini/config/skills/herdr-fleet/SKILL.md" });
    await takenRow.locator(".fleet-entrance-taken").waitFor();
    assert.equal(await takenRow.getByRole("button").count(), 0, "a file the fleet did not write offers no Install or Remove");
    assert.match(readFileSync(ownSkill, "utf8"), /my own/);
    await save(page, shots, "fleet-settings-entrances-dark");
    await settingsPage.getByRole("button", { name: "Close settings" }).click();
    await screen.locator(".fleet-main .fleet-chat").waitFor();

    // the agents outside every thread; Terminal takes the person to the coordinator's real pane
    await screen.locator(".fleet-overview").getByRole("button", { name: "Agents", exact: true }).click();
    await screen.locator(".fleet-run", { hasText: "bench" }).waitFor();
    await screen.locator(".fleet-main-head").getByRole("button", { name: "Terminal" }).click();
    await screen.waitFor({ state: "detached" });
    assert.equal(await page.locator(".screen-switch button[aria-pressed='true']").getAttribute("title"), "Pane");
    await page.locator(".view-switch").waitFor();

    // a request sent from a pane's conversation names that pane, and Open pane opens it while it is there
    // (the README lead's pane is real; bench's is a stand-in id, as a pane that closed)
    await page.route(`**/api/pane/conversation?pane_id=${encodeURIComponent(coordinator.paneId)}*`, (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ history_id: "asked", source: "claude-transcript", cursor: null, turns: [
        { role: "user", ts: "2026-10-11T09:00:00.000Z", parts: [{ kind: "text", text: `[from pane ${bench.paneId}]\n\nTidy the bench script.` }] },
        { role: "assistant", ts: "2026-10-11T09:00:05.000Z", parts: [{ kind: "text", text: "Started a thread." }] },
        { role: "user", ts: "2026-10-11T09:01:00.000Z", parts: [{ kind: "text", text: `[from pane ${readme.paneId}]\n\nFix the doubled login error.` }] },
      ] }),
    }));
    await page.locator(".fleet-button").click();
    await screen.locator(".fleet-main .chat-asked-from").first().waitFor();
    const closedPane = screen.locator(".fleet-main .chat-turn-user", { hasText: "Tidy the bench script." }).locator(".chat-asked-from");
    assert.match(await closedPane.textContent() ?? "", /From a pane\s*Closed pane/);
    assert.equal(await closedPane.getByRole("button").count(), 0, "a pane that closed is not offered");
    const asked = screen.locator(".fleet-main .chat-turn-user", { hasText: "Fix the doubled login error." }).locator(".chat-asked-from");
    assert.match(await asked.textContent() ?? "", /From a pane\s*herdr-fleet-test-Update-the-README/);
    assert.equal(await screen.locator(".fleet-main .chat-bubble", { hasText: "Fix the doubled login error." }).count(), 1);
    assert.equal(await screen.locator(".fleet-main .chat-bubble", { hasText: "[from pane" }).count(), 0, "the opening line is not shown as the message");
    await save(page, shots, "fleet-asked-from-pane-dark");
    await asked.getByRole("button", { name: "Open pane" }).click();
    await screen.waitFor({ state: "detached" });
    assert.equal(await page.locator(".screen-switch button[aria-pressed='true']").getAttribute("title"), "Pane");
    assert.equal(JSON.parse(await page.evaluate(() => sessionStorage.getItem("herdr-fleet:selection") ?? "{}")).pane_id, readme.paneId);
    assert.deepEqual(errors, []);
    await desktop.close();

    for (const theme of shots ? ["light"] : []) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
      await context.addInitScript((t) => localStorage.setItem("herdr-fleet:settings", JSON.stringify({ theme: t })), theme);
      const light = await context.newPage();
      await light.goto(origin);
      await light.locator(".fleet-button").click();
      await light.locator("#fleet-group-needs").waitFor();
      await save(light, shots, `fleet-desktop-${theme}`);
      await context.close();
    }

    // on a phone: the conversation, the Overview as a sheet, a thread on the whole screen
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
    await phone.addInitScript(() => localStorage.setItem("herdr-fleet:settings", JSON.stringify({})));
    const mobile = await phone.newPage();
    const mobileErrors: string[] = [];
    mobile.on("pageerror", (error) => mobileErrors.push(error.message));
    await mobile.goto(origin);
    await mobile.locator(".fleet-button").click();
    const phoneScreen = mobile.locator(".fleet-screen");
    await phoneScreen.waitFor();
    const sideways = () => mobile.evaluate(() => {
      const screenBox = document.querySelector(".fleet-screen")!;
      return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, screenBox.scrollWidth - screenBox.clientWidth);
    });
    // the Overview starts open: on a phone it is the sheet; Close leaves the conversation
    await phoneScreen.locator(".fleet-overview").waitFor();
    await save(mobile, shots, "fleet-phone-overview-dark");
    await phoneScreen.locator(".fleet-sheet-close").click();
    await phoneScreen.locator(".fleet-overview").waitFor({ state: "detached" });
    assert.equal(await sideways(), 0, "nothing scrolls sideways on a phone");
    await save(mobile, shots, "fleet-phone-dark");
    await phoneScreen.locator(".fleet-overview-button").click();
    await phoneScreen.locator(".fleet-row", { hasText: "Fix the retry" }).click();
    await phoneScreen.locator(".fleet-screen.has-open .fleet-open").or(mobile.locator(".fleet-screen.has-open .fleet-open")).first().waitFor();
    const covers = await mobile.evaluate(() => {
      const box = document.querySelector(".fleet-overview")!.getBoundingClientRect();
      const screenBox = document.querySelector(".fleet-screen")!.getBoundingClientRect();
      return Math.abs(box.top - screenBox.top) < 2 && Math.abs(box.height - screenBox.height) < 2;
    });
    assert.ok(covers, "an open thread takes the whole screen on a phone");
    assert.equal(await sideways(), 0);
    await save(mobile, shots, "fleet-phone-thread-dark");
    // its change, the files over the diff
    await phoneScreen.getByRole("button", { name: "Changes", exact: true }).click();
    await phoneScreen.locator(".fleet-file.is-on", { hasText: "src/retry.ts" }).waitFor();
    assert.equal(await sideways(), 0, "a change does not push the screen sideways on a phone");
    await save(mobile, shots, "fleet-phone-changes-dark");
    // the answered plan of another thread, on the whole screen
    await phoneScreen.getByRole("button", { name: "Back to threads" }).click();
    await phoneScreen.locator(".fleet-row", { hasText: "Limit the retries" }).click();
    await phoneScreen.getByRole("button", { name: /^Plan/ }).click();
    await phoneScreen.locator(".fleet-plan-done", { hasText: "Answered" }).waitFor();
    await phoneScreen.locator(".fleet-plan-claim.level-1 summary").first().click();
    assert.equal(await sideways(), 0, "a plan does not push the screen sideways on a phone");
    await save(mobile, shots, "fleet-phone-plan-dark");
    // the Settings page from the drawer, on the whole screen
    await mobile.locator(".drawer-toggle").click();
    await mobile.locator(".fleet-rail-settings").click();
    await phoneScreen.locator(".fleet-settings .fleet-role", { hasText: "lead" }).waitFor();
    // the drawer closes with the pick, and slides away
    await mobile.locator(".drawer-toggle[aria-expanded='false']").waitFor();
    await Bun.sleep(400);
    await phoneScreen.locator(".fleet-role-head", { hasText: "lead" }).click();
    assert.equal(await sideways(), 0, "the Settings page does not push the screen sideways on a phone");
    // every section's tab is on the screen, the last one too
    const lastTab = await phoneScreen.getByRole("button", { name: "Language", exact: true }).boundingBox();
    assert.ok(lastTab && lastTab.x + lastTab.width <= 390, "the Settings page's last tab fits a phone's width");
    await save(mobile, shots, "fleet-phone-settings-dark");
    assert.deepEqual(mobileErrors, []);
    await phone.close();
  } finally {
    server?.stop();
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

async function save(page: Page, folder: string | undefined, name: string): Promise<void> {
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  try {
    await checkFleetScreen(browser);
    console.log("fleet screen: ok");
  } finally {
    await browser.close();
  }
}
