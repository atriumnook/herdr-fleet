import { useEffect, useState } from "react";
import type { Emit } from "../../ui/bubble.ts";
import { relay } from "../../ui/bubble.ts";
import type { FleetScreenModel, RunCardModel, RunTone } from "../../ui/fleetView.ts";
import type { UiEvent } from "../../ui/state.ts";
import { t } from "../../lib/i18n.ts";
import { RunCard, type RunCardEvent } from "./RunCard.tsx";
import { RunDetailSheet, type RunDetailEvent } from "./RunDetailSheet.tsx";
import { UsageCapsule, type UsageCapsuleEvent } from "./UsageCapsule.tsx";
import "./Fleet.css";

/** What the Fleet screen hands up to the Root: the Mediator's own events, complete. */
export type FleetScreenEvent = Extract<UiEvent, { type: "show-run" | "hide-run" | "open-pane" | "interrupt-run" | "close-done" | "clear-cooldown" | "refresh-usage" | "dismiss-error" }>;

/** The clock the elapsed times read: a view-only tick, it decides nothing. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** A run's own link in the chain: what its card or sheet emits becomes the Mediator's event for that run. */
export function forRun(emit: Emit<FleetScreenEvent>, runId: string): Emit<RunCardEvent | RunDetailEvent> {
  return relay(emit, (event, pass) => {
    if (event.type === "open-pane") pass({ type: "open-pane", runId });
    else if (event.type === "interrupt") pass({ type: "interrupt-run", runId });
    else if (event.type === "show-detail") pass({ type: "show-run", runId });
    else pass({ type: "hide-run" });
  });
}

/**
 * The Fleet screen, a Passive View over FleetScreenModel: usage capsules beside the title, then
 * the runs in the order they need the person, ended ones folded at the end, and the chosen run's
 * detail on a sheet in front. It floats over the pane, which stays attached underneath.
 */
export function FleetScreen({ model, emit }: { model: FleetScreenModel; emit: Emit<FleetScreenEvent> }) {
  const now = useNow(1000);
  // purely visual: whether the folded ended runs are shown
  const [endedOpen, setEndedOpen] = useState(false);
  const empty = model.status === "ready" && model.sections.length === 0 && model.ended.length === 0;
  const heading: Record<Exclude<RunTone, "ended">, string> = {
    needs: t("Needs you"), failed: t("Failed"), working: t("Working"), done: t("Done"),
  };
  const card = (run: RunCardModel) => <RunCard key={run.id} run={run} now={run.tone === "working" || run.tone === "needs" ? now : run.updatedAt} emit={forRun(emit, run.id)} />;

  return (
    <div className="fleet-screen" aria-label={t("Fleet")}>
      <div className="fleet-backdrop" aria-hidden="true" />
      <div className="fleet-scroll">
        <header className="fleet-head">
          <div className="fleet-title">
            <h1>{t("Fleet")}</h1>
            <span>{t("{needs} need you · {failed} failed · {working} working · {done} done", model.counts)}</span>
          </div>
          <div className="fleet-capsules" role="group" aria-label={t("Usage")}>
            {model.usage.capsules.map((capsule) => (
              <UsageCapsule key={capsule.key} capsule={capsule} now={now} emit={relay<UsageCapsuleEvent, FleetScreenEvent>(emit, (_, pass) => pass({ type: "clear-cooldown", key: capsule.key }))} />
            ))}
            {model.canAct && (
              <button type="button" className="btn" disabled={model.usage.refreshing} onClick={() => emit({ type: "refresh-usage" })}>
                {model.usage.refreshing ? t("Refreshing…") : t("Refresh usage")}
              </button>
            )}
          </div>
        </header>

        {model.requestError && (
          <div className="fleet-alert" role="alert">
            <span>{model.requestError}</span>
            <button type="button" className="btn" onClick={() => emit({ type: "dismiss-error" })}>{t("Dismiss")}</button>
          </div>
        )}
        {model.status === "error" && <div className="fleet-alert" role="alert">{t("Could not load the fleet. {error}", { error: model.error ?? "" })}</div>}
        {model.status === "loading" && model.sections.length === 0 && <p className="fleet-empty">{t("Loading the fleet…")}</p>}
        {empty && (
          <div className="fleet-empty">
            <p>{t("No fleet agents yet")}</p>
            <p>{t("Agents started with fleet spawn show here.")}</p>
          </div>
        )}

        {model.sections.map((section) => (
          <section key={section.tone} className={`fleet-section tone-${section.tone}`} aria-labelledby={`fleet-${section.tone}`}>
            <div className="fleet-section-head">
              <h2 id={`fleet-${section.tone}`}>{heading[section.tone]}</h2>
              {section.tone === "done" && model.closableGroups.map((group) => (
                <button key={group} type="button" className="btn btn-ghost" disabled={model.busy} onClick={() => emit({ type: "close-done", group })}>
                  {t("Close finished panes")}{model.closableGroups.length > 1 ? ` · ${group}` : ""}
                </button>
              ))}
            </div>
            <div className={section.tone === "working" ? "fleet-group" : "fleet-stack"}>{section.runs.map(card)}</div>
          </section>
        ))}

        {model.ended.length > 0 && (
          <section className="fleet-section tone-ended">
            <button type="button" className="btn btn-ghost" aria-expanded={endedOpen} onClick={() => setEndedOpen((open) => !open)}>
              {endedOpen ? t("Hide ended runs") : t("Show {count} ended runs", { count: model.ended.length })}
            </button>
            {endedOpen && <div className="fleet-stack">{model.ended.map(card)}</div>}
          </section>
        )}
      </div>

      {model.detail && <RunDetailSheet run={model.detail} now={model.detail.tone === "working" || model.detail.tone === "needs" ? now : model.detail.updatedAt} emit={forRun(emit, model.detail.id)} />}
    </div>
  );
}
