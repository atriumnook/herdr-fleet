import type { Emit } from "../../ui/bubble.ts";
import type { UsageCapsuleModel } from "../../ui/fleetView.ts";
import { t } from "../../lib/i18n.ts";
import { WindowName, clock } from "./format.tsx";

/** What a capsule can ask for; the strip adds which account. */
export type UsageCapsuleEvent = { type: "clear-cooldown" };

/**
 * One account's usage as a floating capsule: a ring filled to its tightest window, the account and
 * its windows, and, while it cools down after a rate limit, until when and a way to end it.
 */
export function UsageCapsule({ capsule, now, emit }: { capsule: UsageCapsuleModel; now: number; emit: Emit<UsageCapsuleEvent> }) {
  const percent = capsule.worst ? Math.round(capsule.worst.usedPercent) : null;
  const title = [
    ...capsule.windows.map((window) => `${window.name} ${window.usedPercent}%${window.resetsAt ? ` (${clock(window.resetsAt, now)})` : ""}`),
    capsule.error ? t("The last read failed. {error}", { error: capsule.error }) : "",
  ].filter(Boolean).join("\n");
  return (
    <div className={`fleet-capsule level-${capsule.level}${capsule.cooldown ? " is-cooling" : ""}`} title={title || undefined}>
      {percent !== null && (
        <span className="fleet-ring" style={{ "--fleet-ring": `${percent}%` } as React.CSSProperties} aria-hidden="true"><span>{percent}</span></span>
      )}
      <span className="fleet-capsule-text">
        <b>{capsule.key}</b>
        {capsule.cooldown ? (
          <span className="fleet-capsule-sub is-cooling">{t("Cooling down until {time}", { time: clock(capsule.cooldown.until, now) })}</span>
        ) : capsule.worst ? (
          <span className="fleet-capsule-sub">
            {capsule.windows.map((window, index) => (
              <span key={window.name}>{index > 0 && " · "}<WindowName name={window.name} /> {Math.round(window.usedPercent)}%</span>
            ))}
          </span>
        ) : (
          <span className="fleet-capsule-sub">{t(capsule.error ? "Last read failed" : "No reading yet")}</span>
        )}
      </span>
      {capsule.cooldown && capsule.canClear && (
        <button type="button" className="btn" disabled={capsule.busy} onClick={() => emit({ type: "clear-cooldown" })}>{t("Clear")}</button>
      )}
    </div>
  );
}
