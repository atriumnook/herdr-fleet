import { useT } from "../lib/i18n.ts";
import type { Emit } from "../ui/bubble.ts";
import type { PushTest } from "../ui/state.ts";

/** What Settings → Alerts' test row draws. */
export interface PushTestModel {
  alertsOn: boolean;
  /** this browser can take push alerts at all */
  supported: boolean;
  /** notifications are blocked in the browser's settings */
  denied: boolean;
  result: PushTest;
}

/** A test push for the Mediator, or turning alerts on again, which the shell does. */
export type PushTestEvent = { type: "send-test-push" } | { type: "repair-alerts" };

export function PushTestControls({ model, emit }: { model: PushTestModel; emit: Emit<PushTestEvent> }) {
  const t = useT();
  const { alertsOn, supported, denied, result } = model;
  const busy = result === "sending";
  const enable = !alertsOn || result === "missing" || result === "permission";

  return (
    <>
      <div className="settings-row">
        <div><span className="settings-label">{t("Test notification")}</span><span className="settings-description">{t("Check whether this device can receive push alerts")}</span></div>
        <button type="button" className="btn" disabled={busy || !alertsOn || !supported || denied} onClick={() => emit({ type: "send-test-push" })}>{busy ? t("Sending…") : t("Send test")}</button>
      </div>
      <p className="settings-hint" role="status">
        {!supported || result === "unsupported" ? t("Push alerts need HTTPS or localhost, and on iPhone the home-screen app.")
          : denied ? t("Allow notifications in your browser settings, then try again.")
          : result === "sent" ? t("Test notification sent. Check this device for the alert.")
          : result === "missing" ? t("This device's push subscription is missing. Turn alerts on again.")
          : result === "permission" ? t("Allow notifications to test alerts on this device.")
          : result === "failed" ? t("Could not send the test notification. Try again.")
          : !alertsOn ? t("Alerts off") : null}
      </p>
      {enable && supported && !denied && <div className="phone-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => emit({ type: "repair-alerts" })}>{t("Turn alerts on again")}</button>
      </div>}
    </>
  );
}
