import type { Emit } from "../../ui/bubble.ts";
import type { RunCardModel } from "../../ui/fleetView.ts";
import { t } from "../../lib/i18n.ts";
import { AgentMark } from "../AgentMark.tsx";
import { StateBadge, elapsed } from "./format.tsx";

/** What a run card can ask for; its section adds which run. */
export type RunCardEvent = { type: "open-pane" } | { type: "interrupt" } | { type: "show-detail" };

/**
 * One run as a card on a field face. A run that needs the person or failed is nearest; one that
 * needs the person also carries its question and the one way to answer it. Passive: it shows
 * `run` and emits.
 */
export function RunCard({ run, now, emit }: { run: RunCardModel; now: number; emit: Emit<RunCardEvent> }) {
  const prominent = run.tone === "needs";
  const near = prominent || run.tone === "failed";
  return (
    <article className={`fleet-run tone-${run.tone}${near ? " is-near" : ""}${prominent ? " is-prominent" : ""}${run.depth > 1 ? " is-child" : ""}`} style={{ "--fleet-depth": Math.max(0, run.depth - 1) } as React.CSSProperties}>
      <div className="fleet-run-head">
        <AgentMark agent={run.agent} size={near ? 22 : 18} className="fleet-run-mark" />
        <button type="button" className="fleet-run-name" onClick={() => emit({ type: "show-detail" })}>
          <b>{run.name}</b>
          <span className="fleet-run-meta">{[run.role, run.agent, run.model, run.thinking].filter(Boolean).join(" · ")}</span>
        </button>
        <StateBadge state={run.state} />
        <span className="fleet-run-elapsed">{elapsed(now - run.startedAt)}</span>
        <div className="fleet-run-actions">
          {run.canOpenPane && (
            <button type="button" className={prominent ? "btn btn-primary" : "btn"} onClick={() => emit({ type: "open-pane" })}>
              {t(prominent ? "Open pane to answer" : "Open pane")}
            </button>
          )}
          {run.canInterrupt && !prominent && (
            <button type="button" className="btn btn-ghost" disabled={run.busy} onClick={() => emit({ type: "interrupt" })}>{t("Interrupt")}</button>
          )}
        </div>
      </div>
      {run.question && <p className="fleet-run-question">{run.question}</p>}
      {run.error && <p className="fleet-run-error">{run.error}</p>}
      {run.replacedBy && <p className="fleet-run-note">{t("Replaced by {name}", { name: run.replacedBy.name })}</p>}
      {!run.replacedBy && run.fallbackFrom && <p className="fleet-run-note">{t("Switched from {model}", { model: run.fallbackFrom })}</p>}
      {run.tone === "done" && run.result && <pre className="fleet-run-result">{run.result}</pre>}
    </article>
  );
}
