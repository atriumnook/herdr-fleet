/**
 * The factory's metrics for a project, without the fleet's server: the same report as `fleet report`
 * (server/fleet/metrics.ts), read from the event log file and GitHub here. Reads only.
 *
 *   bun scripts/factory-report.ts [--project <repo>] [--base <branch>] [--hours 24] [--events <file>] [--quiet-minutes 15] [--planned-label <regex>]
 *
 * --project defaults to the git root of the working folder, --base to the branch checked out there
 * (the threads' base: pull requests merged elsewhere are not this project's), --events to
 * fleet-events.jsonl in the fleet's state folder.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { listIssues, listMergedPullRequests } from "../server/fleet/github.ts";
import { metrics, readEvents, render } from "../server/fleet/metrics.ts";
import { defaultStateDir } from "../server/state-dir.ts";

const { values } = parseArgs({ options: { project: { type: "string" }, base: { type: "string" }, "planned-label": { type: "string" }, hours: { type: "string" }, events: { type: "string" }, "quiet-minutes": { type: "string" } } });
const git = (args: string[]) => Bun.spawnSync(["git", "-c", "core.fsmonitor=false", ...args], { stdout: "pipe" }).stdout.toString().trim();
const project = values.project ?? git(["rev-parse", "--show-toplevel"]);
if (!project) throw new Error("--project is required outside a git repository");
const base = values.base ?? git(["-C", project, "branch", "--show-current"]);
const to = Date.now();
const from = to - Number(values.hours ?? 24) * 3_600_000;
const events = readEvents(values.events ?? join(defaultStateDir(), "fleet-events.jsonl"));
const [merged, issues] = await Promise.all([listMergedPullRequests(project), listIssues(project)]);
console.log(render(project, base, metrics({ events, project, base, from, to, quietMs: Number(values["quiet-minutes"] ?? 15) * 60_000, merged, issues, ...(values["planned-label"] ? { planned: new RegExp(values["planned-label"]) } : {}) })));
