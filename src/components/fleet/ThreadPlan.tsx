import { useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { Emit } from "../../ui/bubble.ts";
import type { PlanAskModel, PlanClaimModel, PlanModel } from "../../ui/fleetView.ts";
import type { UiEvent } from "../../ui/state.ts";
import type { PlanExhibit } from "../../../shared/plan.ts";
import { t } from "../../lib/i18n.ts";
import { ConfirmDialog } from "../ConfirmDialog.tsx";

/** What the Plan tab hands up: the Mediator's own events, complete. */
export type PlanEvent = Extract<UiEvent, { type: "plan-choose" | "plan-comment" | "plan-note" | "plan-respond" | "plan-confirm" | "plan-cancel" | "plan-dropped-seen" }>;

/** A count's label, one or many: labels stay English (src/lib/i18n.ts). */
function count(n: number, one: string, many: string): string {
  return t(n === 1 ? one : many, { n });
}

/** The decisions under a claim, its own included, that the person has not looked at. */
function unseen(claim: PlanClaimModel): number {
  return (claim.ask && !claim.ask.seen ? 1 : 0) + claim.children.reduce((sum, child) => sum + unseen(child), 0);
}

/**
 * A thread lead's plan, a Passive View over PlanModel: the tree of claims closed to its first
 * level, which reads as the summary, each claim opening to its exhibit, its decision and the claims
 * under it. The person picks options and comments on claims; Respond sends it all to the lead in
 * one message, after a yes. Once answered, the answers sent show in place.
 */
export function ThreadPlan({ plan, emit }: { plan: PlanModel; emit: Emit<PlanEvent> }) {
  const root = useRef<HTMLDivElement>(null);
  // answered, or closed because the lead went on without answers: the plan only shows
  const answered = plan.answeredAt !== undefined || plan.closedAt !== undefined;
  // purely visual: the next decision not looked at, its claims opened and scrolled into view
  const toNext = () => {
    const ask = root.current?.querySelector<HTMLElement>(`[data-ask="${CSS.escape(plan.toAnswer[0] ?? "")}"]`);
    if (!ask) return;
    for (let node: HTMLElement | null = ask; node && node !== root.current; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement) node.open = true;
    }
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ask.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    ask.querySelector<HTMLButtonElement>("[aria-checked='true']")?.focus({ preventScroll: true });
  };
  if (plan.status === "error") return <div className="notice fleet-notice" role="alert"><span>{t("Could not read the plan. {error}", { error: plan.error ?? "" })}</span></div>;
  if (plan.title === undefined) return <p className="fleet-quiet fleet-pane-note">{t("Reading the plan…")}</p>;
  const confirm = plan.confirm;
  return (
    <div className="fleet-plan" ref={root}>
      <div className="fleet-plan-body">
        {plan.dropped !== undefined && (
          <div className="notice fleet-plan-dropped" role="status">
            <span>{t("The lead handed over version {version} of the plan, so your answers to version {old} were dropped.", { version: plan.version, old: plan.dropped })}</span>
            <button type="button" className="btn btn-ghost" onClick={() => emit({ type: "plan-dropped-seen" })}>{t("Dismiss")}</button>
          </div>
        )}
        <header className="fleet-plan-head">
          <h3>{plan.title}</h3>
          <span className="fleet-plan-version mono">v{plan.version}</span>
        </header>
        {plan.why.length > 0 && (
          <details className="fleet-plan-why">
            <summary>{count(plan.why.length, "Why · 1 request", "Why · {n} requests")}</summary>
            {plan.why.map((quote, index) => <blockquote key={index}>{quote}</blockquote>)}
          </details>
        )}
        <ol className="fleet-plan-tree">
          {plan.claims.map((claim) => <Claim key={claim.id} claim={claim} runId={plan.runId} answered={answered} emit={emit} />)}
        </ol>
        {plan.shared && (
          <section className="fleet-plan-aux" aria-label={t("Shared")}>
            <h4>{t("Shared")}</h4>
            <ol className="fleet-plan-tree"><Claim claim={plan.shared} runId={plan.runId} answered={answered} emit={emit} /></ol>
          </section>
        )}
        {plan.scope.length > 0 && (
          <section className="fleet-plan-aux" aria-label={t("Not changing")}>
            <h4>{t("Not changing")}</h4>
            <ul>{plan.scope.map((item, index) => <li key={index}>{item}</li>)}</ul>
          </section>
        )}
      </div>
      <footer className="fleet-plan-foot">
        {answered ? (
          <>
            {plan.note && <p className="fleet-plan-sent-note"><b>{t("Note")}</b> {plan.note}</p>}
            <span className="fleet-plan-done">{plan.answeredAt !== undefined ? t("Answered · sent to the lead") : t("Closed · the lead went on without answers")}</span>
          </>
        ) : (
          <>
            <textarea className="fleet-plan-note-input" rows={1} value={plan.note} placeholder={t("Note for the lead")} aria-label={t("Note for the lead")}
              onChange={(event) => emit({ type: "plan-note", runId: plan.runId, text: event.target.value })} />
            <div className="fleet-plan-actions">
              {plan.comments > 0 && <span className="fleet-plan-count">{count(plan.comments, "1 comment", "{n} comments")}</span>}
              <span className="fleet-grow" />
              {plan.toAnswer.length > 0 && <button type="button" className="btn" onClick={toNext}>{t("{n} to answer", { n: plan.toAnswer.length })}</button>}
              <button type="button" className="btn btn-primary" disabled={!plan.canRespond} onClick={() => emit({ type: "plan-respond", runId: plan.runId })}>{t("Respond")}</button>
            </div>
          </>
        )}
      </footer>
      {confirm && (
        <ConfirmDialog
          title={t("Send your answers to the lead?")}
          body={t("The lead gets your decisions and comments as its next task, and builds the change to them. A decision you did not open keeps the lead's recommendation.")}
          items={[
            ...confirm.decisions.map((each) => t(!each.seen ? "{number} {question} → {choice} (not opened)" : each.recommended ? "{number} {question} → {choice} (recommended)" : "{number} {question} → {choice}",
              { number: each.number, question: each.question, choice: each.choice })),
            ...(confirm.comments ? [count(confirm.comments, "1 comment", "{n} comments")] : []),
            ...(confirm.note ? [t("A note for the lead")] : []),
          ]}
          confirmLabel={t("Send answers")} pending={confirm.running} error={confirm.error ?? null}
          onConfirm={() => emit({ type: "plan-confirm" })} onClose={() => emit({ type: "plan-cancel" })} />
      )}
    </div>
  );
}

function Claim({ claim, runId, answered, emit }: { claim: PlanClaimModel; runId: string; answered: boolean; emit: Emit<PlanEvent> }) {
  // purely visual: whether the comment box shows
  const [commenting, setCommenting] = useState(false);
  const left = unseen(claim);
  return (
    <li className={`fleet-plan-claim level-${claim.level}`}>
      <details>
        <summary>
          <span className="fleet-plan-number mono">{claim.id === "shared" ? "·" : claim.id}</span>
          <span className="fleet-plan-text">{claim.text}</span>
          {claim.comment && <MessageSquare className="fleet-plan-commented" aria-label={t("Commented")} />}
          {!answered && left > 0 && <span className="fleet-plan-left">{t("{n} to answer", { n: left })}</span>}
        </summary>
        <div className="fleet-plan-claim-body">
          {claim.exhibit && <Exhibit exhibit={claim.exhibit} />}
          {claim.ask && <Ask ask={claim.ask} runId={runId} answered={answered} emit={emit} />}
          {answered ? claim.comment && <p className="fleet-plan-comment"><b>{t("Your comment")}</b> {claim.comment}</p>
            : commenting || claim.comment ? (
              <div className="fleet-plan-comment-box composer-box">
                <textarea rows={2} autoFocus={commenting && !claim.comment} value={claim.comment} placeholder={t("Comment on {claim}", { claim: claim.id })} aria-label={t("Comment on {claim}", { claim: claim.id })}
                  onChange={(event) => emit({ type: "plan-comment", runId, claim: claim.id, text: event.target.value })}
                  onBlur={() => { if (!claim.comment) setCommenting(false); }} />
              </div>
            ) : <button type="button" className="btn btn-ghost fleet-plan-comment-button" onClick={() => setCommenting(true)}><MessageSquare aria-hidden="true" />{t("Comment")}</button>}
          {claim.children.length > 0 && (
            <ol className="fleet-plan-tree">
              {claim.children.map((child) => <Claim key={child.id} claim={child} runId={runId} answered={answered} emit={emit} />)}
            </ol>
          )}
        </div>
      </details>
    </li>
  );
}

function Ask({ ask, runId, answered, emit }: { ask: PlanAskModel; runId: string; answered: boolean; emit: Emit<PlanEvent> }) {
  return (
    <div className={`fleet-plan-ask${ask.seen ? " is-seen" : ""}`} data-ask={ask.id}>
      <p className="fleet-plan-question" id={`plan-ask-${runId}-${ask.id}`}><b className="mono">{ask.number}</b> {ask.question}</p>
      <div className="fleet-plan-options" role="radiogroup" aria-labelledby={`plan-ask-${runId}-${ask.id}`}>
        {ask.options.map((option) => {
          const on = option.value === ask.chosen;
          return (
            <button key={option.value} type="button" role="radio" aria-checked={on} disabled={answered} className={`fleet-plan-option${on ? " is-on" : ""}`}
              onClick={() => emit({ type: "plan-choose", runId, ask: ask.id, value: option.value })}>
              <span className="fleet-plan-radio" aria-hidden="true" />
              <span className="fleet-plan-option-text">
                <b>{option.label}</b>
                {option.recommended && <span className="pill">{t("Recommended")}</span>}
                {option.note && <span className="fleet-plan-option-note">{option.note}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One exhibit: lines of the worktree, code the lead proposes, a schema, a call stack, or a list. */
function Exhibit({ exhibit }: { exhibit: PlanExhibit }) {
  switch (exhibit.kind) {
    case "code": {
      const place = exhibit.lines && exhibit.start !== undefined ? `${exhibit.path}:${exhibit.start}${exhibit.end && exhibit.end !== exhibit.start ? `–${exhibit.end}` : ""}` : exhibit.path;
      return (
        <figure className="fleet-plan-exhibit">
          <figcaption className="mono">{place}{exhibit.text !== undefined && <span className="pill">{t("Proposed")}</span>}</figcaption>
          {exhibit.lines
            ? <div className="fleet-plan-code mono">{exhibit.lines.map((line, index) => <div key={index}><span className="fleet-line-no">{(exhibit.start ?? 1) + index}</span><span className="fleet-line-text">{line}</span></div>)}</div>
            : <pre className="fleet-plan-code mono">{exhibit.text}</pre>}
        </figure>
      );
    }
    case "schema":
      return (
        <figure className="fleet-plan-exhibit">
          {exhibit.lang && <figcaption className="mono">{exhibit.lang}</figcaption>}
          <pre className="fleet-plan-code mono">{exhibit.text}</pre>
        </figure>
      );
    case "calls":
      return (
        <figure className="fleet-plan-exhibit">
          <div className="fleet-plan-calls mono">
            {exhibit.rows.map((row, index) => (
              <div key={index} className="fleet-plan-call" style={{ paddingLeft: `calc(${row.depth} * var(--space-4) + var(--space-3))` }}>
                <span>{row.text}</span>{row.at && <span className="fleet-plan-call-at">{row.at}</span>}
              </div>
            ))}
          </div>
        </figure>
      );
    case "list":
      return <ul className="fleet-plan-list">{exhibit.items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
  }
}
