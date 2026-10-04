import type { AgentState } from "../../../shared/fleet.ts";
import { useT } from "../../lib/i18n.ts";

/** `4:12`, `1:03:07`: how long a run has gone, from its start. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A clock time today, or a short date and time further off. */
export function clock(ms: number, now: number): string {
  const at = new Date(ms);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return sameDay
    ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** A run's state, written as well as colored. */
export function StateBadge({ state }: { state: AgentState }) {
  const t = useT();
  const tone = state === "blocked" ? "blocked" : state === "failed" ? "failed" : state === "idle" || state === "done" ? "done" : state === "stopped" ? "ended" : "working";
  return (
    <span className={`fleet-badge is-${tone}`}>
      {t(state === "blocked" ? "Waiting" : state === "failed" ? "Failed" : state === "starting" ? "Starting" : state === "unknown" ? "Unknown"
        : state === "idle" || state === "done" ? "Done" : state === "stopped" ? "Ended" : "Working")}
    </span>
  );
}

/** A usage window's name as the server gives it: `5h` stays, `weekly` and `monthly` are words. */
export function WindowName({ name }: { name: string }) {
  const t = useT();
  if (name === "weekly" || name === "monthly") return <>{t(name === "weekly" ? "Week" : "Month")}</>;
  return <>{name}</>;
}
