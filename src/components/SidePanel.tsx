import { useState, type ReactNode } from "react";
import { MessagesSquare, SquareTerminal, X } from "lucide-react";
import { t } from "../lib/i18n.ts";
import { Segmented } from "./Segmented.tsx";
import type { Emit } from "../ui/bubble.ts";
import type { SidePanelModel } from "../ui/sidePanelView.ts";
import type { SidePanelTab } from "../ui/state.ts";
import "./SidePanel.css";

export type SidePanelEvent =
  | { type: "side-panel"; open: boolean; tab?: SidePanelTab }
  | { type: "open-side-terminal"; machineId: string; paneId: string }
  | { type: "start-side-chat"; paneId: string; text: string }
  | { type: "show-screen"; screen: "pane" };

export interface SidePanelProps {
  model: SidePanelModel;
  /** the side chat's conversation and composer, once it runs */
  chat: ReactNode;
  /** the terminal's grid, once it is open */
  terminal: ReactNode;
  emit: Emit<SidePanelEvent>;
}

/**
 * The side panel, beside the pane shown on either screen: a side chat that answers questions about
 * the pane's conversation without joining it, and a terminal in the pane's folder. Each tab keeps
 * what it shows while the other is in front, so a terminal's screen and a chat's place stay.
 */
export function SidePanel({ model, chat, terminal, emit }: SidePanelProps) {
  if (!model.open) return null;
  const { about } = model;
  const tab = (id: SidePanelTab, label: string, icon: ReactNode) => (
    <button type="button" aria-pressed={model.tab === id} onClick={() => emit({ type: "side-panel", open: true, tab: id })}>
      {icon}<span>{label}</span>
    </button>
  );
  return (
    <>
      <button type="button" className="side-panel-scrim" aria-label={t("Close side panel")} onClick={() => emit({ type: "side-panel", open: false })} />
      <aside className="side-panel" aria-label={t("Side panel")}>
        <header className="side-panel-head">
          <Segmented label={t("Side panel")} className="side-panel-tabs">
            {tab("chat", t("Side chat"), <MessagesSquare aria-hidden="true" />)}
            {tab("terminal", t("Terminal"), <SquareTerminal aria-hidden="true" />)}
          </Segmented>
          <button type="button" className="icon-button" aria-label={t("Close side panel")} title={t("Close side panel")} onClick={() => emit({ type: "side-panel", open: false })}>
            <X />
          </button>
        </header>
        {about && <p className="side-panel-about" title={about.cwd ?? undefined}><span>{t("About")}</span> <b>{about.title}</b></p>}
        <section className="side-panel-body" aria-label={t("Side chat")} hidden={model.tab !== "chat"}>
          {about === null ? <p className="side-panel-quiet">{t("Open a pane to ask about it.")}</p> : <SideChat key={about.paneId} model={model} paneId={about.paneId} chat={chat} emit={emit} />}
        </section>
        <section className="side-panel-body" aria-label={t("Terminal")} hidden={model.tab !== "terminal"}>
          {about === null
            ? <p className="side-panel-quiet">{t("Open a pane to open a terminal in its folder.")}</p>
            : <SideTerminal model={model} about={about} terminal={terminal} emit={emit} />}
        </section>
      </aside>
    </>
  );
}

function SideChat({ model, paneId, chat, emit }: { model: SidePanelModel; paneId: string; chat: ReactNode; emit: Emit<SidePanelEvent> }) {
  // what is typed: the box's own until it is sent
  const [text, setText] = useState("");
  const slot = model.chat;
  if (slot.kind === "open") return <div className="side-panel-chat">{chat}</div>;
  const busy = slot.kind === "opening";
  const send = () => { if (text.trim() && !busy) emit({ type: "start-side-chat", paneId, text: text.trim() }); };
  return (
    <div className="side-panel-start">
      <p>{t("Ask about this conversation without interrupting it. An agent that changes nothing reads the conversation and the code, and answers here.")}</p>
      {slot.kind === "failed" && <p className="side-panel-error" role="alert">{slot.message}</p>}
      <div className="composer-box side-panel-ask">
        <textarea rows={3} value={text} placeholder={t("Ask on the side")} aria-label={t("Ask on the side")} disabled={busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } }} />
        <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={send}>{busy ? t("Starting…") : t("Ask")}</button>
      </div>
    </div>
  );
}

function SideTerminal({ model, about, terminal, emit }: { model: SidePanelModel; about: NonNullable<SidePanelModel["about"]>; terminal: ReactNode; emit: Emit<SidePanelEvent> }) {
  const slot = model.terminal;
  if (slot.kind === "open") return <div className="side-panel-terminal">{terminal}</div>;
  if (slot.kind === "in-pane") {
    return (
      <div className="side-panel-start">
        <p>{t("This terminal is the pane open on the Pane screen.")}</p>
        <button type="button" className="btn" onClick={() => emit({ type: "show-screen", screen: "pane" })}>{t("Show it")}</button>
      </div>
    );
  }
  const busy = slot.kind === "opening";
  return (
    <div className="side-panel-start">
      <p>{t("A shell in this pane's folder, in a tab of its workspace. herdr shows the same tab.")}</p>
      {about.cwd && <p className="side-panel-cwd mono">{about.cwd}</p>}
      {slot.kind === "failed" && <p className="side-panel-error" role="alert">{slot.message}</p>}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => emit({ type: "open-side-terminal", machineId: about.machineId, paneId: about.paneId })}>
        {busy ? t("Opening…") : t("Open terminal")}
      </button>
    </div>
  );
}
