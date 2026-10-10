import { useEffect, useRef, useState } from "react";
import { Check, Pencil, RefreshCw, Trash2, X } from "lucide-react";

import "./DevicesPanel.css";

import { copyText } from "../lib/clipboard.ts";
import type { HealthAuth } from "../../shared/protocol.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { QrCode } from "./QrCode.tsx";
import { LOCALE, t } from "../lib/i18n.ts";
import type { Emit } from "../ui/bubble.ts";
import type { DevicesPanelModel } from "../ui/devicesView.ts";
import type { UiEvent } from "../ui/state.ts";

/** What the panel sends up: the Mediator's own events, complete. */
export type DevicesPanelEvent = Extract<UiEvent, { type: "pair-device" | "end-pairing" | "start-rename" | "edit-rename" | "cancel-rename" | "save-rename" | "revoke-device" | "confirm-revoke" | "cancel-revoke" }>;

export interface DevicesPanelProps {
  model: DevicesPanelModel;
  emit: Emit<DevicesPanelEvent>;
}

export const VIA: Record<NonNullable<HealthAuth["via"]>, string> = {
  local: "You are on the PC itself.",
  tailscale: "You are in as this PC's Tailscale login.",
  device: "This is a paired device.",
  token: "You are in with the access token.",
};

function lastSeen(value: string | null): string {
  if (value === null) return t("never");
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60_000);
  if (minutes < 2) return t("just now");
  if (minutes < 60) return t("{n} min ago", { n: minutes });
  if (minutes < 60 * 48) return t("{n} h ago", { n: Math.round(minutes / 60) });
  return new Date(value).toLocaleDateString(LOCALE);
}

/** The time a code has left, as m:ss; drawn on a clock of its own, as the Mediator drops the code once it expires. */
function useTimeLeft(expiresAt: string | null): string {
  const [left, setLeft] = useState("");
  useEffect(() => {
    if (expiresAt === null) return;
    const tick = () => {
      const ms = Math.max(0, Date.parse(expiresAt) - Date.now());
      setLeft(`${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return left;
}

/** Settings → Devices: the paired devices, and a code to pair one more. */
export function DevicesPanel({ model, emit }: DevicesPanelProps) {
  const { list: devices, pairing, renaming, confirming, justPaired } = model;
  const confirmingDevice = devices?.find((d) => d.id === confirming) ?? null;
  const left = useTimeLeft(pairing?.expiresAt ?? null);
  // the copy feedback is the button's own: the clipboard needs the link element for its fallback
  const [linkCopied, setLinkCopied] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const error = model.failure === null ? null : model.failure.kind === "unavailable" ? t("Devices are managed on a real server.") : model.failure.message;
  const qrValue = pairing?.link ?? null;

  return (
    <div className="devices-panel">
      {model.via !== undefined && <p className="settings-description">{t(VIA[model.via])}</p>}
      <p className="settings-description">{t("A paired device gets in on its own, from anywhere it can reach this server, until you revoke it here. A code comes from this screen on the PC or on a device already paired.")}</p>
      {devices === null ? <p className="settings-hint" role="status">{t("Loading…")}</p> : devices.length === 0 ? (
        <p className="settings-hint">{t("No devices paired yet.")}</p>
      ) : (
        <ul className="devices-list">
          {devices.map((d) => (
            <li key={d.id} className="devices-row">
              {renaming?.id === d.id ? (
                <form className="devices-rename" onSubmit={(e) => { e.preventDefault(); emit({ type: "save-rename" }); }}>
                  <input className="input" value={renaming.label} maxLength={48} autoFocus aria-label={t("Device name")} onChange={(e) => emit({ type: "edit-rename", label: e.target.value })} />
                  <button type="submit" className="icon-button" aria-label={t("Save name")}><Check /></button>
                  <button type="button" className="icon-button" aria-label={t("Cancel")} onClick={() => emit({ type: "cancel-rename" })}><X /></button>
                </form>
              ) : (
                <>
                  <div className="devices-name">
                    <span className="settings-label">{d.label}{d.current && <span className="devices-current">{t("this device")}</span>}</span>
                    <span className="settings-description">{t("Last seen {when}", { when: lastSeen(d.last_seen_at) })}</span>
                  </div>
                  <div className="devices-actions">
                    <button type="button" className="icon-button" aria-label={t("Rename {name}", { name: d.label })} onClick={() => emit({ type: "start-rename", id: d.id, label: d.label })}><Pencil /></button>
                    <button type="button" className="btn btn-ghost" onClick={() => emit({ type: "revoke-device", id: d.id })}>
                      <Trash2 aria-hidden="true" />{t("Revoke")}
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirmingDevice && (
        <ConfirmDialog
          title={t("Revoke {name}?", { name: confirmingDevice.label })}
          body={t("This device stops getting in, and gets in again only with a new pairing.")}
          confirmLabel={t("Revoke")}
          pending={false}
          error={null}
          onConfirm={() => emit({ type: "confirm-revoke" })}
          onClose={() => emit({ type: "cancel-revoke" })}
        />
      )}
      {justPaired !== null && <p className="settings-hint" role="status">{t("Paired: {name}.", { name: justPaired })}</p>}
      {pairing === null ? (
        <div className="phone-actions"><button type="button" className="btn btn-primary" onClick={() => emit({ type: "pair-device" })} disabled={model.unavailable}>{t("Pair a device")}</button></div>
      ) : (
        <div className="devices-pairing" role="status">
          {qrValue !== null && <QrCode value={qrValue} label={t("QR code that pairs a phone with code {code}", { code: pairing.code })} />}
          <div>
            <p className="settings-label">{t("Enter this code on the other device.")}</p>
            <p className="devices-code">{pairing.spaced}</p>
            <p className="settings-description">
              {t(qrValue !== null ? "Or scan the QR code: it opens the app with the code filled in." : "Open the app's address on that device and enter it.")} {t("Expires in {time}.", { time: left })}
            </p>
            {qrValue !== null && (
              <p className="devices-link">
                <span className="settings-description">{t("Or send it this link.")}</span>
                <a ref={linkRef} href={qrValue}>{qrValue}</a>
                <button type="button" className="btn btn-ghost" onClick={() => void copyText(qrValue, linkRef.current).then((ok) => { if (ok) { setLinkCopied(true); window.setTimeout(() => setLinkCopied(false), 1600); } })}>{t(linkCopied ? "Copied" : "Copy")}</button>
              </p>
            )}
            <div className="phone-actions">
              <button type="button" className="btn" onClick={() => emit({ type: "pair-device" })}><RefreshCw aria-hidden="true" />{t("New code")}</button>
              <button type="button" className="btn btn-ghost" onClick={() => emit({ type: "end-pairing" })}>{t("Done")}</button>
            </div>
          </div>
        </div>
      )}
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
}
