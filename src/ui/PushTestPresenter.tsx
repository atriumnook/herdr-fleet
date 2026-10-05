import { PushTestControls, type PushTestEvent } from "../components/PushTestControls.tsx";
import { pushSupported } from "../lib/push.ts";
import type { Emit } from "./bubble.ts";
import { useSelected } from "./presenter.ts";

/** Settings → Alerts' test row: the push test region and the alerts switch, with what this browser allows. */
export function PushTestPresenter({ emit }: { emit: Emit<PushTestEvent> }) {
  const result = useSelected((state) => state.pushTest);
  const alertsOn = useSelected((state) => state.settings.alertsOn);
  const model = { alertsOn, result, supported: pushSupported(), denied: globalThis.Notification?.permission === "denied" };
  return <PushTestControls model={model} emit={emit} />;
}
