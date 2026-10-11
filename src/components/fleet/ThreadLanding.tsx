import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import type { Emit } from "../../ui/bubble.ts";
import type { CheckModel, DiffFileModel, DiffLineModel, LandingModel, PlanModel } from "../../ui/fleetView.ts";
import type { ThreadTab, UiEvent } from "../../ui/state.ts";
import type { LandAction } from "../../../shared/fleet.ts";
import { t } from "../../lib/i18n.ts";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { Segmented } from "../Segmented.tsx";

/** What landing a thread hands up: the Mediator's own events, complete. */
export type LandingEvent = Extract<UiEvent, {
  type: "fleet-tab" | "fleet-land" | "landing-comment" | "landing-uncomment" | "landing-clear-comments" | "landing-confirm" | "landing-cancel";
}>;

/** A count's label, one or many: labels stay English (src/lib/i18n.ts). */
function count(n: number, one: string, many: string, vars: Record<string, string | number> = {}): string {
  return t(n === 1 ? one : many, { n, ...vars });
}

const PENDING: Record<string, string> = {
  pr: "Lead is opening a PR…", update: "Lead is updating the branch…", "fix-ci": "Lead is fixing CI…", comments: "Lead is taking your comments…",
  merge: "Coordinator is merging…", "merge-pr": "Coordinator is merging the PR…",
};

/**
 * The steps a thread offers where it stands: review it (Discard, Merge into the base, Create PR),
 * or land its pull request. `resolve` is the thread's own Resolve or Reopen, first in the row.
 */
export function LandingActions({ landing, resolve, emit }: { landing: LandingModel; resolve?: ReactNode; emit: Emit<LandingEvent> }) {
  const land = (action: LandAction) => emit({ type: "fleet-land", runId: landing.runId, action });
  if (landing.landed) {
    return <div className="fleet-land-actions"><span className="fleet-land-done">{landing.landed === "merged" ? t("Merged into {base}", { base: landing.baseBranch }) : t("Discarded")}</span></div>;
  }
  const { offers, can } = landing;
  return (
    <div className="fleet-land-actions">
      {resolve}
      {landing.pending && <span className="fleet-land-pending" role="status">{t(PENDING[landing.pending] ?? "Working…")}</span>}
      <span className="fleet-grow" />
      {landing.pr?.state === "OPEN" && (
        <a className="btn btn-ghost" href={landing.pr.url} target="_blank" rel="noreferrer">{t("PR #{n}", { n: landing.pr.number })}<ExternalLink aria-hidden="true" /></a>
      )}
      {offers.discard && <button type="button" className="btn btn-ghost" disabled={!can.discard} onClick={() => land("discard")}>{t("Discard")}</button>}
      {offers.mergeLocal && <button type="button" className="btn" disabled={!can.merge} onClick={() => land("merge")}>{t("Merge into {base}", { base: landing.baseBranch })}</button>}
      {offers.createPr && <button type="button" className="btn btn-primary" disabled={!can.lead} onClick={() => land("pr")}>{t("Create PR")}</button>}
      {offers.fixCi && <button type="button" className="btn" disabled={!can.lead} onClick={() => land("fix-ci")}>{t("Fix CI")}</button>}
      {offers.mergePr && <button type="button" className="btn btn-primary" disabled={!can.merge || !landing.mergePrReady} onClick={() => land("merge-pr")}>{t("Merge PR")}</button>}
    </div>
  );
}

/** Chat, Plan, Changes and Checks: the open thread's views, Plan when its lead wrote one, the others on a branch of its own. */
export function ThreadTabs({ tab: shown, landing, plan, emit }: { tab: ThreadTab; landing: LandingModel | null; plan: PlanModel | null; emit: Emit<LandingEvent> }) {
  const tab = (name: ThreadTab, label: string, extra?: ReactNode) => (
    <button type="button" aria-pressed={shown === name} onClick={() => emit({ type: "fleet-tab", tab: name })}>{t(label)}{extra}</button>
  );
  // the decisions not looked at yet, or a mark while the plan waits to be sent
  const toAnswer = plan?.toAnswer.length ?? 0;
  return (
    <div className="fleet-tabs">
      <Segmented label={t("Thread view")}>
        {tab("chat", "Chat")}
        {plan && tab("plan", "Plan", plan.answeredAt === undefined ? <span className="fleet-tab-alert" aria-label={t("Needs you")}>{toAnswer || "!"}</span> : null)}
        {landing && tab("changes", "Changes", landing.comments.length > 0 ? <span className="pill">{landing.comments.length}</span> : null)}
        {landing && tab("checks", "Checks", landing.attention ? <span className="fleet-tab-alert" aria-label={t("Needs a look")}>!</span> : null)}
      </Segmented>
      {landing && shown === "changes" && <span className="fleet-tabs-note mono">{t("compared with {base}", { base: landing.baseBranch })}</span>}
    </div>
  );
}

/**
 * The thread's change: its files, and the chosen one's diff. A line clicked takes a comment; the
 * comments wait, marked not sent, until Send to lead hands them over together.
 */
export function ThreadChanges({ landing, emit }: { landing: LandingModel; emit: Emit<LandingEvent> }) {
  const { changes } = landing;
  // purely visual: the file shown, and the line a comment is being written on
  const [chosen, setChosen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const file = changes.files.find((each) => each.path === chosen) ?? changes.files[0];
  useEffect(() => { setEditing(null); }, [file?.path]);
  if (changes.status === "error") return <div className="notice fleet-notice" role="alert"><span>{t("Could not read the change. {error}", { error: changes.error ?? "" })}</span></div>;
  if (changes.files.length === 0) return <p className="fleet-quiet fleet-pane-note">{changes.status === "ready" ? t("No changes yet") : t("Loading changes…")}</p>;
  return (
    <div className="fleet-changes">
      <div className="fleet-changes-body">
        <nav className="fleet-files" aria-label={t("Changed files")}>
          {changes.files.map((each) => (
            <button key={each.path} type="button" className={`fleet-file${each === file ? " is-on" : ""}`} aria-current={each === file ? "true" : undefined} onClick={() => setChosen(each.path)}>
              <span className="fleet-file-name" title={each.path}>{each.path}</span>
              {each.comments > 0 && <span className="fleet-file-comments" aria-label={count(each.comments, "1 comment", "{n} comments")}>{each.comments}</span>}
              <span className="fleet-diff"><span className="fleet-diff-add">+{each.added}</span> <span className="fleet-diff-del">−{each.removed}</span></span>
            </button>
          ))}
        </nav>
        {file && <FileDiff key={file.path} file={file} runId={landing.runId} editing={editing} setEditing={setEditing} emit={emit} />}
      </div>
      {changes.truncated && <p className="fleet-pane-note">{t("The change is too large to show in full; the rest is cut.")}</p>}
      {landing.comments.length > 0 && (
        <div className="fleet-comment-queue">
          <span>{count(landing.comments.length, "1 comment for the lead", "{n} comments for the lead, sent together")}</span>
          <span className="fleet-grow" />
          <button type="button" className="btn btn-ghost" onClick={() => emit({ type: "landing-clear-comments", runId: landing.runId })}>{t("Discard comments")}</button>
          <button type="button" className="btn btn-primary" disabled={!landing.can.lead} onClick={() => emit({ type: "fleet-land", runId: landing.runId, action: "comments" })}>{t("Send to lead")}</button>
        </div>
      )}
    </div>
  );
}

const lineKey = (line: DiffLineModel): string => (line.kind === "del" ? `-${line.old}` : `+${line.new}`);

function FileDiff({ file, runId, editing, setEditing, emit }: { file: DiffFileModel; runId: string; editing: string | null; setEditing: (key: string | null) => void; emit: Emit<LandingEvent> }) {
  // what is typed: the box's own until the comment is added
  const [draft, setDraft] = useState("");
  const add = (line: DiffLineModel) => {
    if (!draft.trim()) return;
    const removed = line.kind === "del";
    emit({ type: "landing-comment", runId, comment: { file: file.path, line: (removed ? line.old : line.new)!, ...(removed ? { removed: true } : {}), text: draft.trim() } });
    setDraft("");
    setEditing(null);
  };
  return (
    <div className="fleet-diff-view">
      <div className="fleet-diff-head"><span className="mono">{file.from ? `${file.from} → ${file.path}` : file.path}</span><span className="fleet-grow" /><span>{t("Click a line to comment")}</span></div>
      {file.binary && <p className="fleet-pane-note">{t("Binary file")}</p>}
      <div className="fleet-diff-lines mono">
        {file.lines.map((line, index) => {
          const key = lineKey(line);
          const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : "";
          return (
            <div key={index}>
              {line.kind === "hunk"
                ? <div className="fleet-line is-hunk"><span className="fleet-line-text">{line.text}</span></div>
                : (
                  <button type="button" className={`fleet-line is-${line.kind}${line.comments.length ? " has-comment" : ""}`} aria-label={t("Comment on line {n}", { n: (line.kind === "del" ? line.old : line.new) ?? "" })}
                    onClick={() => { setEditing(key); setDraft(""); }}>
                    <span className="fleet-line-no">{line.old ?? ""}</span><span className="fleet-line-no">{line.new ?? ""}</span><span className="fleet-line-sign">{sign}</span><span className="fleet-line-text">{line.text}</span>
                  </button>
                )}
              {line.comments.map((comment) => (
                <div key={comment.index} className="fleet-line-comment">
                  <span className="fleet-line-comment-who">{t("not sent")}</span>
                  <span className="fleet-line-comment-text">{comment.text}</span>
                  <button type="button" className="btn btn-ghost" onClick={() => emit({ type: "landing-uncomment", runId, index: comment.index })}>{t("Remove")}</button>
                </div>
              ))}
              {editing === key && line.kind !== "hunk" && (
                <div className="fleet-comment-box composer-box">
                  <textarea rows={2} autoFocus value={draft} placeholder={t("Comment for the lead")} aria-label={t("Comment for the lead")}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); add(line); }
                      if (event.key === "Escape") { event.preventDefault(); setEditing(null); }
                    }} />
                  <div className="fleet-comment-box-actions">
                    <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>{t("Cancel")}</button>
                    <button type="button" className="btn" disabled={!draft.trim()} onClick={() => add(line)}>{t("Add comment")}</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const MARK: Record<CheckModel["tone"], string> = { ok: "✓", warn: "!", bad: "✗", run: "…", none: "·" };
const CONTRACT_MARK = { met: "✓", open: "·", unmet: "✗" } as const;

/** One check's words and the step that settles it: what the Checks view draws. */
function checkText(check: CheckModel, landing: LandingModel): { title: string; sub?: string; action?: { label: string; step: "update" | "comments" | "fix-ci" } } {
  switch (check.kind) {
    case "committed":
      return check.uncommitted.length
        ? { title: count(check.uncommitted.length, "1 file not committed", "{n} files not committed"), sub: check.uncommitted.join(" · ") }
        : { title: t("All work committed"), sub: count(check.ahead, "1 commit on {branch}", "{n} commits on {branch}", { branch: landing.branch }) };
    case "base":
      return check.behind
        ? { title: count(check.behind, "{base} moved 1 commit ahead", "{base} moved {n} commits ahead", { base: check.baseBranch }), sub: t("The lead merges {base} into its branch and checks again.", { base: check.baseBranch }), action: { label: t("Update branch"), step: "update" } }
        : { title: t("Up to date with {base}", { base: check.baseBranch }) };
    case "contract":
      return check.items.length
        ? { title: t(check.tone === "ok" ? "Contract met" : "Contract open"), sub: check.items.map((item) => `${item.id} ${CONTRACT_MARK[item.state]}`).join(" ") }
        : { title: t("No contract") };
    case "review":
      return check.reviewers.length
        ? { title: t("Reviewed on another CLI"), sub: check.reviewers.map((reviewer) => `reviewer · ${reviewer.agent}${reviewer.status ? ` — ${reviewer.status}` : ""}`).join(" / ") }
        : { title: t("No review on another CLI") };
    case "comments":
      return check.count
        ? { title: count(check.count, "1 comment not sent", "{n} comments not sent"), sub: t("They go to the lead in one message."), action: { label: t("Send to lead"), step: "comments" } }
        : { title: t("No open comments") };
    case "pr":
      if (check.pr) return { title: t(check.pr.state === "MERGED" ? "PR #{n} merged" : check.pr.state === "CLOSED" ? "PR #{n} closed" : "PR #{n} open", { n: check.pr.number }), sub: check.pr.url };
      if (check.error) return { title: t("Could not read GitHub"), sub: check.error };
      return { title: t("Not opened yet"), sub: t("Create PR has the lead push {branch} and open a pull request into {base}.", { branch: landing.branch, base: landing.baseBranch }) };
    case "ci":
      return check.pr.checks === "fail"
        ? { title: t("Checks failed"), sub: (check.pr.failing ?? []).join(" · "), action: { label: t("Fix CI"), step: "fix-ci" } }
        : { title: t(check.pr.checks === "pass" ? "Checks passed" : check.pr.checks === "pending" ? "Checks running" : "No checks") };
  }
}

/** What stands between the thread and landing: its branch, the thread itself, its pull request. */
export function ThreadChecks({ landing, emit }: { landing: LandingModel; emit: Emit<LandingEvent> }) {
  const { checks } = landing;
  const section = (title: string, items: CheckModel[]) => items.length > 0 && (
    <section className="fleet-checks-section" aria-label={t(title)}>
      <h3>{t(title)}</h3>
      {items.map((check) => {
        const text = checkText(check, landing);
        return (
          <div key={check.kind} className={`fleet-check tone-${check.tone}`}>
            <span className="fleet-check-mark" aria-hidden="true">{MARK[check.tone]}</span>
            <b>{text.title}</b>
            {text.action && (
              <button type="button" className="btn" disabled={!landing.can.lead} onClick={() => emit({ type: "fleet-land", runId: landing.runId, action: text.action!.step })}>{text.action.label}</button>
            )}
            {text.sub && <span className="fleet-check-sub">{text.sub}</span>}
          </div>
        );
      })}
    </section>
  );
  return (
    <div className="fleet-checks">
      {landing.error && <div className="notice fleet-check-error" role="alert">{landing.error}</div>}
      {checks.status === "error" && <div className="notice fleet-check-error" role="alert">{t("Could not read the checks. {error}", { error: checks.error ?? "" })}</div>}
      {checks.status === "loading" && checks.branch.length === 0 && <p className="fleet-quiet">{t("Reading git and GitHub…")}</p>}
      {section("Branch", checks.branch)}
      {section("Thread", checks.thread)}
      {section("Pull request", checks.pr)}
    </div>
  );
}

/** The yes a merge or a discard waits for: what happens, and whether it can be undone. */
export function LandingConfirm({ landing, emit }: { landing: LandingModel; emit: Emit<LandingEvent> }) {
  const confirm = landing.confirm;
  if (!confirm) return null;
  const { branch, baseBranch: base, repo, pr } = landing;
  const texts = confirm.action === "merge" ? {
    title: t("Merge {branch} into {base}?", { branch, base }),
    body: t("The coordinator merges it into {base} in {repo} with a merge commit, and pushes nothing.", { base, repo }),
    items: [
      t("Once it is merged, the fleet removes the worktree and the branch {branch}.", { branch }),
      t("To undo it, revert the merge commit on {base}.", { base }),
      t("If {repo} has changes of its own or is on another branch, the coordinator stops and tells you.", { repo }),
    ],
    label: t("Merge into {base}", { base }),
  } : confirm.action === "merge-pr" ? {
    title: t("Merge PR #{n}?", { n: pr?.number ?? "" }),
    body: t("The coordinator merges pull request #{n} on GitHub with a merge commit.", { n: pr?.number ?? "" }),
    items: [
      t("Once it is merged, the fleet removes the worktree and the branch {branch}.", { branch }),
      t("Then the coordinator brings {base} in {repo} up to date.", { base, repo }),
    ],
    label: t("Merge PR"),
  } : {
    title: t("Discard this thread?"),
    body: t("This throws the thread's change away. It cannot be undone."),
    items: [
      t("Removes the worktree {path}.", { path: confirm.worktree }),
      confirm.ahead !== undefined ? t("Deletes the branch {branch} and its {n} commits.", { branch, n: confirm.ahead }) : t("Deletes the branch {branch} and its commits.", { branch }),
      t("Closes the panes of the lead and its helpers."),
      ...(pr?.state === "OPEN" ? [t("Pull request #{n} stays open on GitHub.", { n: pr.number })] : []),
    ],
    label: t("Discard"),
  };
  return <ConfirmDialog title={texts.title} body={texts.body} items={texts.items} confirmLabel={texts.label} pending={confirm.running} error={confirm.error ?? null}
    onConfirm={() => emit({ type: "landing-confirm" })} onClose={() => emit({ type: "landing-cancel" })} />;
}
