import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, Maximize2, Minimize2, PanelRight, SquareTerminal } from "lucide-react";
import type { Emit } from "../../ui/bubble.ts";
import { relay } from "../../ui/bubble.ts";
import type { FleetScreenModel, OpenRunModel, ThreadRowModel } from "../../ui/fleetView.ts";
import type { UiEvent } from "../../ui/state.ts";
import { t } from "../../lib/i18n.ts";
import { AgentMark } from "../AgentMark.tsx";
import { Segmented } from "../Segmented.tsx";
import { RunCard, type RunCardEvent } from "./RunCard.tsx";
import { DiffCount, ThreadBadge } from "./ThreadCard.tsx";
import "./Fleet.css";

/** What the Fleet screen hands up to the Root: the Mediator's own events, complete. */
export type FleetScreenEvent = Extract<UiEvent, {
  type: "fleet-overview" | "fleet-open" | "fleet-member" | "fleet-close" | "fleet-expand" | "fleet-start-project" | "fleet-resolve"
    | "open-pane" | "interrupt-run" | "dismiss-error";
}>;

/** The clock the elapsed times read: a view-only tick, it decides nothing. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** An agent's own link in the chain: what its card emits becomes the Mediator's event for that run. */
export function forRun(emit: Emit<FleetScreenEvent>, runId: string): Emit<RunCardEvent> {
  return relay(emit, (event, pass) => {
    if (event.type === "open-pane") pass({ type: "open-pane", runId });
    else if (event.type === "interrupt") pass({ type: "interrupt-run", runId });
    else pass({ type: "fleet-open", kind: "agent", runId });
  });
}

export interface FleetScreenProps {
  model: FleetScreenModel;
  /** the project conversation: the coordinator's pane as a chat, while one lives */
  conversation: ReactNode;
  /** the open thread's or agent's pane as a chat */
  side: ReactNode;
  emit: Emit<FleetScreenEvent>;
}

/**
 * The Fleet screen, a Passive View over FleetScreenModel: the project conversation in the middle,
 * the Overview beside it (the threads by what they ask of the person, the agents outside them), and
 * a thread or agent opened there, large in the middle when expanded. On a phone the Overview is a
 * sheet and an open thread takes the screen. The chats come in as slots from the Presenter.
 */
export function FleetScreen({ model, conversation, side, emit }: FleetScreenProps) {
  const open = model.open;
  const big = model.expanded && open !== null;
  const classes = ["fleet-screen", model.overview ? "has-overview" : "", open ? "has-open" : "", big ? "is-expanded" : ""].filter(Boolean).join(" ");
  return (
    <div className={classes} aria-label={t("Fleet")}>
      <div className="fleet-backdrop" aria-hidden="true" />
      <section className="fleet-main" aria-label={big ? open.title : t("Project conversation")}>
        {big ? <OpenRun open={open} side={side} large emit={emit} /> : <Conversation model={model} conversation={conversation} emit={emit} />}
      </section>
      {model.overview && (
        <>
          <button type="button" className="fleet-sheet-scrim" aria-label={t("Close Overview")} onClick={() => emit({ type: "fleet-overview", open: false })} />
          <aside className="fleet-overview" aria-label={t("Overview")}>
            {open && !big ? <OpenRun open={open} side={side} large={false} emit={emit} /> : <Overview model={model} emit={emit} />}
          </aside>
        </>
      )}
    </div>
  );
}

function OverviewButton({ model, emit }: { model: FleetScreenModel; emit: Emit<FleetScreenEvent> }) {
  return (
    <button type="button" className={`btn fleet-overview-button${model.overview ? " is-on" : ""}`} aria-pressed={model.overview}
      aria-label={model.needs > 0 ? t("Overview: {count} need you", { count: model.needs }) : t("Overview")} title={t("Overview")}
      onClick={() => emit({ type: "fleet-overview", open: !model.overview })}>
      {model.needs > 0 && <span className="fleet-needs-dot" aria-hidden="true" />}
      <PanelRight aria-hidden="true" />
      <span className="fleet-overview-label">{t("Overview")}</span>
    </button>
  );
}

function Conversation({ model, conversation, emit }: { model: FleetScreenModel; conversation: ReactNode; emit: Emit<FleetScreenEvent> }) {
  const project = model.project;
  return (
    <>
      <header className="fleet-main-head">
        <b className="fleet-main-title">{project?.name ?? t("Fleet")}</b>
        {model.coordinator && <span className="fleet-main-meta mono">coordinator · {model.coordinator.agent}</span>}
        <span className="fleet-grow" />
        {model.coordinator && (
          <button type="button" className="btn btn-ghost" onClick={() => emit({ type: "open-pane", runId: model.coordinator!.runId })}>
            <SquareTerminal aria-hidden="true" /><span className="fleet-hide-narrow">{t("Terminal")}</span>
          </button>
        )}
        {project && <OverviewButton model={model} emit={emit} />}
      </header>
      {model.requestError && (
        <div className="notice fleet-notice" role="alert">
          <span>{model.requestError}</span>
          <button type="button" className="btn btn-ghost" onClick={() => emit({ type: "dismiss-error" })}>{t("Dismiss")}</button>
        </div>
      )}
      {model.status === "error" && <div className="notice fleet-notice" role="alert">{t("Could not load the fleet. {error}", { error: model.error ?? "" })}</div>}
      {project === null
        ? <div className="fleet-empty"><h2>{t("No projects yet")}</h2><p>{t("Start one from New project")}</p></div>
        : model.coordinator ? conversation : <AskProject key={project.path} name={project.name} cwd={project.path} busy={model.busy} canAct={model.canAct} emit={emit} />}
    </>
  );
}

/** The first message to a project with no coordinator: sending it starts one. */
function AskProject({ name, cwd, busy, canAct, emit }: { name: string; cwd: string; busy: boolean; canAct: boolean; emit: Emit<FleetScreenEvent> }) {
  // what is typed: the box's own until it is sent
  const [text, setText] = useState("");
  const send = () => { if (text.trim()) emit({ type: "fleet-start-project", task: text.trim(), cwd }); };
  return (
    <div className="fleet-ask">
      <div className="fleet-ask-head">
        <h2>{t("Ask {name}", { name })}</h2>
        <p>{busy ? t("Starting the coordinator…") : t("No coordinator yet")}</p>
      </div>
      <div className="composer-box fleet-ask-box">
        <textarea className="fleet-ask-input" rows={3} value={text} placeholder={t("Ask {name}", { name })} aria-label={t("Ask {name}", { name })} disabled={!canAct || busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } }} />
        <button type="button" className="btn btn-primary" disabled={!canAct || busy || !text.trim()} onClick={send}>{t("Send")}</button>
      </div>
    </div>
  );
}

function Overview({ model, emit }: { model: FleetScreenModel; emit: Emit<FleetScreenEvent> }) {
  // purely visual: which list shows, and whether the resolved threads are unfolded
  const [tab, setTab] = useState<"threads" | "agents">("threads");
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const now = useNow(1000);
  const empty = model.threadGroups.length === 0 && model.resolved.length === 0;
  return (
    <>
      <div className="fleet-overview-head">
        <h2>{t("Overview")}</h2>
        <Segmented label={t("Overview list")}>
          <button type="button" aria-pressed={tab === "threads"} onClick={() => setTab("threads")}>{t("Threads")}</button>
          <button type="button" aria-pressed={tab === "agents"} onClick={() => setTab("agents")}>{t("Agents")}</button>
        </Segmented>
        <button type="button" className="btn btn-ghost fleet-sheet-close" onClick={() => emit({ type: "fleet-overview", open: false })}>{t("Close")}</button>
      </div>
      <div className="fleet-overview-body">
        {tab === "threads" ? (
          <>
            {empty && <p className="fleet-quiet">{t("No threads yet")}</p>}
            {model.threadGroups.map((group) => (
              <section key={group.key} className={`fleet-group tone-${group.key}`} aria-labelledby={`fleet-group-${group.key}`}>
                <h3 id={`fleet-group-${group.key}`}>{t(group.label)} <span className="pill">{group.rows.length}</span></h3>
                {group.rows.map((row) => <ThreadRow key={row.id} row={row} now={now} emit={emit} />)}
              </section>
            ))}
            {model.resolved.length > 0 && (
              <section className="fleet-group tone-resolved">
                <button type="button" className="btn btn-ghost fleet-fold" aria-expanded={resolvedOpen} onClick={() => setResolvedOpen((shown) => !shown)}>
                  {resolvedOpen ? t("Hide resolved") : t("Resolved {count}", { count: model.resolved.length })}
                </button>
                {resolvedOpen && model.resolved.map((row) => <ThreadRow key={row.id} row={row} now={now} emit={emit} />)}
              </section>
            )}
          </>
        ) : (
          <section className="fleet-group">
            <h3>{t("Outside threads")} <span className="pill">{model.agents.length}</span></h3>
            {model.agents.length === 0 && <p className="fleet-quiet">{t("No agents yet")}</p>}
            <div className="fleet-stack">
              {model.agents.map((run) => <RunCard key={run.id} run={run} now={run.tone === "working" || run.tone === "needs" ? now : run.updatedAt} emit={forRun(emit, run.id)} />)}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function ThreadRow({ row, now, emit }: { row: ThreadRowModel; now: number; emit: Emit<FleetScreenEvent> }) {
  const minutes = Math.max(0, Math.round((now - row.startedAt) / 60_000));
  const meta = row.state === "working" ? [row.agent, t("{n} min", { n: minutes })] : row.contract.length > 0 ? [row.contract.map((item) => `${item.id} ${MARK[item.state]}`).join(" ")] : [row.agent];
  return (
    <button type="button" className={`fleet-row group-${row.group}${row.selected ? " is-selected" : ""}`} onClick={() => emit({ type: "fleet-open", kind: "thread", runId: row.id })}>
      <b className="fleet-row-title">{row.title}</b>
      {row.group === "review" || row.group === "idle" ? <DiffCount diff={row.diff} /> : <ThreadBadge label={row.label} badge={row.badge} />}
      <span className="fleet-row-meta">{row.branch && <span className="mono">{row.branch}</span>}{meta.map((item) => <span key={item}>{item}</span>)}</span>
      {row.question && <span className="fleet-row-question">{row.question}</span>}
    </button>
  );
}

const MARK = { met: "✓", open: "·", unmet: "✗" } as const;

/** The thread or agent open in the Overview, or large in the middle: its agents, its chat, its actions. */
function OpenRun({ open, side, large, emit }: { open: OpenRunModel; side: ReactNode; large: boolean; emit: Emit<FleetScreenEvent> }) {
  return (
    <div className={`fleet-open${large ? " is-large" : ""}`}>
      <header className="fleet-open-head">
        <button type="button" className="icon-button" aria-label={t(open.kind === "thread" ? "Back to threads" : "Back to agents")} title={t("Back")} onClick={() => emit({ type: "fleet-close" })}>
          <ChevronLeft aria-hidden="true" />
        </button>
        <b className="fleet-open-title">{open.title}</b>
        <ThreadBadge label={open.label} badge={open.badge} />
        {!open.ended && (
          <button type="button" className="icon-button" aria-label={t("Terminal")} title={t("Terminal")} onClick={() => emit({ type: "open-pane", runId: open.paneRunId })}>
            <SquareTerminal aria-hidden="true" />
          </button>
        )}
        <button type="button" className="icon-button fleet-hide-narrow" aria-label={t(large ? "Collapse" : "Expand")} title={t(large ? "Collapse" : "Expand")}
          onClick={() => emit({ type: "fleet-expand", expanded: !large })}>
          {large ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </button>
      </header>
      <div className="fleet-open-meta">
        {open.branch && <span className="mono">{open.branch}</span>}
        <span className="mono">{open.meta}</span>
        <DiffCount diff={open.diff} />
        {open.contract.length > 0 && (
          <span className="fleet-contract">{open.contract.map((item) => <span key={item.id} className={`is-${item.state}`}>{item.id} {MARK[item.state]}</span>)}</span>
        )}
        <span className="fleet-grow" />
        {open.canResolve && <button type="button" className="btn btn-ghost" onClick={() => emit({ type: "fleet-resolve", runId: open.runId, resolved: true })}>{t("Resolve")}</button>}
        {open.resolved && <button type="button" className="btn btn-ghost" onClick={() => emit({ type: "fleet-resolve", runId: open.runId, resolved: false })}>{t("Reopen")}</button>}
      </div>
      {open.skipped.length > 0 && (
        <p className="fleet-open-skipped">{t("Skipped")}: {open.skipped.map((skip) => <span key={skip.candidate} title={skip.reason}><span className="mono">{skip.candidate}</span> ({skip.reason})</span>)}</p>
      )}
      {open.members.length > 1 && (
        <div className="fleet-members" role="group" aria-label={t("Agents in this thread")}>
          {open.members.map((member) => (
            <button key={member.runId ?? "lead"} type="button" className={`fleet-member${member.selected ? " is-selected" : ""}`} aria-pressed={member.selected}
              onClick={() => emit({ type: "fleet-member", runId: member.runId })}>
              <AgentMark agent={member.agent} size={16} />
              <span>{member.name} · {member.agent}</span>
              <span className={`fleet-member-dot badge-${member.badge}`} aria-label={t(member.label)} title={t(member.label)} />
            </button>
          ))}
        </div>
      )}
      {side}
    </div>
  );
}
