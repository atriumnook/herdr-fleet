import "./AccessGate.css";

import { type FormEvent, useEffect, useRef } from "react";

import type { AccessRefusal } from "../../shared/protocol.ts";
import { t } from "../lib/i18n.ts";
import type { Emit } from "../ui/bubble.ts";
import type { GateState, UiEvent } from "../ui/state.ts";

export type AccessGateEvent = Extract<UiEvent, { type: "gate-edit" | "gate-pair" | "gate-unlock" }>;

export interface AccessGateProps {
  /** why the server refused this browser, when it said */
  reason: AccessRefusal | null;
  gate: GateState;
  emit: Emit<AccessGateEvent>;
}

/**
 * Sign-in screen rendered instead of the shell while the server does not know this
 * browser. Pairing is the usual way in: a six-digit code the owner started on the PC
 * (Settings → Devices), typed once, or carried by the QR code's address. The shared
 * token stays as the other way. Nothing is stored here: the server answers with an
 * HttpOnly cookie either way.
 */
export function AccessGate({ reason, gate, emit }: AccessGateProps) {
  const codeRef = useRef<HTMLInputElement | null>(null);
  const tokenRef = useRef<HTMLInputElement | null>(null);
  const { code, token, submitting } = gate;
  const error = gate.error === null ? null
    : gate.error.kind === "message" ? gate.error.message
    : t(gate.error.via === "code" ? "That code is wrong, used up or expired. Start a new pairing on the PC." : "Token does not match.");

  // a refused code or token is selected, to be typed over
  useEffect(() => {
    if (gate.error !== null) (gate.error.via === "code" ? codeRef : tokenRef).current?.select();
  }, [gate.error]);

  const submitCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (code.length !== 6) { codeRef.current?.focus(); return; }
    emit({ type: "gate-pair" });
  };

  const submitToken = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (token === "") { tokenRef.current?.focus(); return; }
    emit({ type: "gate-unlock" });
  };

  return (
    <main className="access-gate-screen">
      <div className="access-gate" data-testid="token-gate">
        <img src="/icons/icon-192.png?v=ram1" alt="" width="44" height="44" className="access-gate-mark" />
        <h1 id="access-gate-title" className="access-gate-title">
          herdr <span className="brand-sub">web ui</span>
        </h1>
        {reason === "other_user" && (
          <p className="access-gate-refused" role="status">{t("Tailscale says this device belongs to someone other than this PC's owner. The owner can still let it in with a pairing code.")}</p>
        )}
        <p className="access-gate-copy">
          {t(reason === "token_required" ? "This server requires an access token or a pairing code." : "Pair this device with a code from the PC: Settings → Devices there.")}
        </p>
        <form aria-labelledby="access-gate-title" onSubmit={submitCode}>
          <label className="access-gate-label" htmlFor="access-gate-code">{t("Pairing code")}</label>
          <input
            ref={codeRef}
            id="access-gate-code"
            className="access-gate-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={7}
            placeholder="000 000"
            autoFocus
            aria-invalid={error !== null && submitting !== "token"}
            aria-describedby={error !== null ? "access-gate-error" : undefined}
            value={code}
            onChange={(event) => emit({ type: "gate-edit", field: "code", value: event.target.value })}
          />
          <button type="submit" className="access-gate-submit" disabled={submitting !== null}>
            {t(submitting === "code" ? "Pairing…" : "Pair this device")}
          </button>
        </form>
        <details className="access-gate-alt">
          <summary>{t("Have an access token instead?")}</summary>
          <form onSubmit={submitToken}>
            <label className="access-gate-label" htmlFor="access-gate-token">{t("Access token")}</label>
            <input
              ref={tokenRef}
              id="access-gate-token"
              className="access-gate-input"
              type="password"
              name="token"
              autoComplete="current-password"
              inputMode="text"
              value={token}
              onChange={(event) => emit({ type: "gate-edit", field: "token", value: event.target.value })}
            />
            <button type="submit" className="access-gate-submit" disabled={submitting !== null}>
              {t(submitting === "token" ? "Unlocking…" : "Unlock")}
            </button>
          </form>
        </details>
        {error !== null && (
          <p id="access-gate-error" className="access-gate-error" role="alert">{error}</p>
        )}
      </div>
    </main>
  );
}
