import { X } from "lucide-react";
import type { Emit } from "../../ui/bubble.ts";
import type { RunCardModel } from "../../ui/fleetView.ts";
import { t } from "../../lib/i18n.ts";
import { AgentMark } from "../AgentMark.tsx";
import { StateBadge, elapsed } from "./format.tsx";

export type RunDetailEvent = { type: "close" } | { type: "open-pane" } | { type: "interrupt" };

/**
 * A run in full, on a glass sheet in front of the list: its state, what it asks or why it failed,
 * how the fleet routed it (the candidates passed over and why), and its last result.
 */
export function RunDetailSheet({ run, now, emit }: { run: RunCardModel; now: number; emit: Emit<RunDetailEvent> }) {
  return (
    <aside className="fleet-sheet" role="dialog" aria-modal="false" aria-labelledby="fleet-sheet-title">
      <header className="fleet-sheet-head">
        <AgentMark agent={run.agent} size={26} />
        <div className="fleet-sheet-title">
          <h2 id="fleet-sheet-title">{run.name}</h2>
          <span>{[run.role, run.agent, run.model, run.thinking].filter(Boolean).join(" · ")}</span>
        </div>
        <button type="button" className="icon-button" aria-label={t("Close")} onClick={() => emit({ type: "close" })}><X /></button>
      </header>

      <dl className="fleet-sheet-facts">
        {run.tone !== "ended" && <div><dt>{t("State")}</dt><dd><StateBadge state={run.state} /></dd></div>}
        <div><dt>{t("Elapsed")}</dt><dd className="mono">{elapsed(now - run.startedAt)}</dd></div>
        <div><dt>{t("Group")}</dt><dd className="mono">{run.group}</dd></div>
      </dl>

      {run.question && (
        <section className="fleet-sheet-section">
          <h3 className="is-blocked">{t("Question")}</h3>
          <p className="fleet-run-question">{run.question}</p>
          <p className="fleet-sheet-hint">{t("The fleet never answers a question; only a person does.")}</p>
        </section>
      )}
      {run.error && (
        <section className="fleet-sheet-section">
          <h3 className="is-blocked">{t("Error")}</h3>
          <p className="fleet-run-error">{run.error}</p>
        </section>
      )}
      {(run.canOpenPane || run.canInterrupt) && (
        <div className="fleet-sheet-actions">
          {run.canOpenPane && <button type="button" className={`fleet-cap${run.tone === "needs" ? " is-primary" : ""}`} onClick={() => emit({ type: "open-pane" })}>{t(run.tone === "needs" ? "Open pane to answer" : "Open pane")}</button>}
          {run.canInterrupt && <button type="button" className="fleet-cap is-quiet" disabled={run.busy} onClick={() => emit({ type: "interrupt" })}>{t("Interrupt")}</button>}
        </div>
      )}

      <section className="fleet-sheet-section">
        <h3>{t("Routing")}</h3>
        <ol className="fleet-route">
          {run.skipped.map((skip) => (
            <li key={skip.candidate} className="is-skipped"><b>{skip.candidate}</b><span>{skip.reason}</span></li>
          ))}
          <li className="is-chosen"><b>{[run.agent, run.model].filter(Boolean).join(":")}</b><span>{t("Started here")}</span></li>
        </ol>
        {run.replacedBy && <p className="fleet-run-note">{t("Replaced by {name}", { name: run.replacedBy.name })}</p>}
      </section>

      <section className="fleet-sheet-section">
        <h3>{t("Result")}</h3>
        {run.result ? <pre className="fleet-run-result">{run.result}</pre> : <p className="fleet-sheet-empty">{t("No result yet. When a turn ends, the HANDOFF the agent wrote shows here.")}</p>}
      </section>

      <footer className="fleet-sheet-foot mono">{t("Depth {depth}", { depth: run.depth })} · run {run.id}</footer>
    </aside>
  );
}
