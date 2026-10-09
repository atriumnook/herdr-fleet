import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { FolderOpen, X } from "lucide-react";

import "./NewSessionDialog.css";

import { AgentPicker } from "./AgentPicker.tsx";
import { t } from "../lib/i18n.ts";
import type { Emit } from "../ui/bubble.ts";
import type { NewSessionState, UiEvent } from "../ui/state.ts";

/** What the dialog draws: the dialog's region while it is open, and the PC's name. */
export type NewSessionModel = Extract<NewSessionState, { open: true }> & { machineName: string };

export type NewSessionEvent = Extract<UiEvent, { type: "close-new-session" | "edit-new-session" | "submit-new-session" }>;

export interface NewSessionDialogProps {
  model: NewSessionModel;
  /** the parent's folder browser, starting at `start`; `pick` puts a folder in the field */
  browser: (start: string, pick: (folder: string) => void) => ReactNode;
  emit: Emit<NewSessionEvent>;
}

function directoryBasename(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.split("/").pop() ?? "";
}

/** A new workspace on a PC, with an agent or a shell in it. The folder browser being open is the view's own. */
export function NewSessionDialog({ model, browser, emit }: NewSessionDialogProps) {
  const { agents, agentKind, cwd, name, createdPaneId } = model;
  const pending = model.status === "starting";
  const [browsing, setBrowsing] = useState(false);
  const firstFieldRef = useRef<HTMLButtonElement>(null);
  const onClose = (): void => emit({ type: "close-new-session" });
  const edit = (field: "agentKind" | "cwd" | "name", value: string): void => emit({ type: "edit-new-session", field, value });

  useEffect(() => { window.requestAnimationFrame(() => firstFieldRef.current?.focus()); }, []);

  const emitRef = useRef(emit);
  emitRef.current = emit;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!pendingRef.current) emitRef.current({ type: "close-new-session" });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectedAgent = agents.find((agent) => agent.kind === agentKind);
  const pendingLabel = selectedAgent ? t("Starting {agent}… up to 60s", { agent: selectedAgent.label }) : t("Starting shell…");
  const fieldsDisabled = pending || createdPaneId !== null;
  const error = model.error === null ? null : model.error.kind === "invalid-cwd" ? t("This folder does not exist.") : model.error.message;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    emit({ type: "submit-new-session" });
  };

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };

  return (
    <div className="modal-scrim new-session-scrim" onMouseDown={closeFromScrim}>
      <form className="modal new-session-modal" role="dialog" aria-modal="true" aria-labelledby="new-session-title" onSubmit={submit}>
        <header className="modal-header">
          <h2 className="modal-title" id="new-session-title">{t("New session")} · {model.machineName}</h2>
          <button type="button" className="icon-button" aria-label={t("Close new session dialog")} disabled={pending} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          <div className="field">
            <span className="field-label" id="new-session-agent">{t("Agent")}</span>
            <AgentPicker ref={firstFieldRef} agents={agents} value={agentKind} disabled={fieldsDisabled} labelledBy="new-session-agent" onChange={(value) => edit("agentKind", value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="new-session-cwd">{t("Directory")}</label>
            <div className="new-session-cwd">
              <input id="new-session-cwd" className="input" value={cwd} disabled={fieldsDisabled} autoComplete="off" onChange={(event) => edit("cwd", event.target.value)} />
              <button type="button" className="btn" aria-expanded={browsing} disabled={fieldsDisabled} onClick={() => setBrowsing((open) => !open)}>
                <FolderOpen aria-hidden="true" />
                {t("Browse")}
              </button>
            </div>
            {browsing && browser(cwd, (picked) => { edit("cwd", picked); setBrowsing(false); })}
            <span className="field-hint">{t("absolute path or ~/…")}</span>
          </div>
          <label className="field">
            <span className="field-label">{t("Name")}</span>
            <input
              className="input"
              value={name}
              disabled={fieldsDisabled}
              autoComplete="off"
              placeholder={directoryBasename(cwd)}
              onChange={(event) => edit("name", event.target.value)}
            />
            <span className="field-hint">{t("Optional workspace label")}</span>
          </label>
          {pending && <p className="new-session-note" role="status">{pendingLabel}</p>}
          {error && <p className="field-hint new-session-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={pending}>{t(pending ? "Starting…" : createdPaneId !== null ? "Open session" : "Start session")}</button>
        </footer>
      </form>
    </div>
  );
}
