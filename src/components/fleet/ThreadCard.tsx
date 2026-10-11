import type { Emit } from "../../ui/bubble.ts";
import type { UiEvent } from "../../ui/state.ts";
import type { Badge, ThreadRowModel } from "../../ui/fleetView.ts";
import type { DiffStat } from "../../../shared/fleet.ts";
import { t } from "../../lib/i18n.ts";
import { AgentMark } from "../AgentMark.tsx";

/** A thread's badge: its state word on the app's one badge look. */
export function ThreadBadge({ label, badge }: { label: string; badge: Badge }) {
  return <span className={`badge badge-${badge}`} data-status={badge}>{t(label)}</span>;
}

/** `+24 −9`: the lines a thread's change adds and removes. */
export function DiffCount({ diff }: { diff: DiffStat | undefined }) {
  if (!diff || diff.added + diff.removed === 0) return null;
  return <span className="fleet-diff" aria-label={t("{added} added, {removed} removed", { added: diff.added, removed: diff.removed })}>
    <span className="fleet-diff-add">+{diff.added}</span> <span className="fleet-diff-del">−{diff.removed}</span>
  </span>;
}

/** the Mediator's own event: the thread opens in the Overview */
export type ThreadCardEvent = Extract<UiEvent, { type: "fleet-open" }>;

/**
 * A thread as a card, under the coordinator's turn that started it: its title, branch, change and
 * state, and what it waits on the person for. The whole card opens the thread.
 */
export function ThreadCard({ thread, emit }: { thread: ThreadRowModel; emit: Emit<ThreadCardEvent> }) {
  const near = thread.group === "needs";
  return (
    <button type="button" className={`fleet-thread-card${near ? " is-near" : ""}${thread.selected ? " is-selected" : ""}`} onClick={() => emit({ type: "fleet-open", kind: "thread", runId: thread.id })}>
      <AgentMark agent={thread.agent} size={18} className="fleet-thread-mark" />
      <span className="fleet-thread-text">
        <b>{thread.title}</b>
        <span className="fleet-thread-meta">{thread.branch && <span className="mono">{thread.branch}</span>}<DiffCount diff={thread.diff} /></span>
      </span>
      <ThreadBadge label={thread.label} badge={thread.badge} />
      {near && thread.question && <span className="fleet-thread-question">{thread.question}</span>}
    </button>
  );
}
