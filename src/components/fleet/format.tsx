import type { AgentState } from "../../../shared/fleet.ts";
import { t } from "../../lib/i18n.ts";
import { toneOf, type RunTone } from "../../ui/fleetView.ts";

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

// the section a run sits in names its state: starting and unknown runs sit under Working
const WORD: Record<Exclude<RunTone, "ended">, string> = { needs: "Needs you", failed: "Failed", working: "Working", done: "Done" };
// the app's one badge (StatusBadge's look): its state classes
const BADGE: Record<Exclude<RunTone, "ended">, string> = { needs: "blocked", failed: "failed", working: "working", done: "done" };

/** A run's state, written as well as colored. An ended run has none: the folded section says it ended. */
export function StateBadge({ state }: { state: AgentState }) {
  const tone = toneOf(state);
  if (tone === "ended") return null;
  return <span className={`badge badge-${BADGE[tone]}`} data-status={BADGE[tone]}>{t(WORD[tone])}</span>;
}

/** A usage window's name as the server gives it: `5h` stays, `weekly` and `monthly` are words. */
export function WindowName({ name }: { name: string }) {
  if (name === "weekly" || name === "monthly") return <>{t(name === "weekly" ? "Week" : "Month")}</>;
  return <>{name}</>;
}
