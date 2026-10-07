/** Browser-only regression fixture, bundled by chat-history-browser-qa.ts. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { loadSettings, SettingsProvider } from "../src/lib/settings.ts";
import { ChatPresenter } from "../src/ui/ChatPresenter.tsx";
import { useWholeOutput } from "../src/lib/useWholeOutput.ts";
import { MachineContext } from "../src/lib/machineContext.tsx";
import { Mediator } from "../src/ui/mediator.ts";
import { FLEET_PORTS } from "../src/ui/Root.tsx";
import { MediatorContext } from "../src/ui/presenter.ts";
import "../src/styles.css";

declare global { interface Window { qa: { requests: { url: string; signal: AbortSignal; resolve: (text: string) => void; reject: () => void }[]; target: (url: string, scope: string) => void; chat: (pane: string, machine?: string) => void; refresh: () => void } } }
const nativeFetch = window.fetch;
window.qa = { requests: [], target: () => {}, chat: () => {}, refresh: () => {} };
window.fetch = (input, init) => {
  const url = String(input);
  if (!url.includes("tool-output") && !url.startsWith("/qa-output")) return nativeFetch(input, init);
  // Deliberately ignores cancellation: late transports must still be harmless.
  return new Promise((resolve, reject) => window.qa.requests.push({ url, signal: init!.signal as AbortSignal,
    resolve: (text) => resolve(new Response(text)), reject: () => reject(new Error("late failure")) }));
};
// the Root's Mediator reads the chat's conversation, as in the app (no prompt is read: no agent)
const mediator = new Mediator(FLEET_PORTS);

function Fixture() {
  const [target, setTarget] = useState({ url: "/qa-output?pane=a&ref=x", scope: "one" });
  const [pane, setPane] = useState("a");
  const [machine, setMachine] = useState("local");
  const output = useWholeOutput(target.url, target.scope);
  window.qa.target = (url, scope) => setTarget({ url, scope });
  window.qa.chat = (pane, machine = "local") => { setPane(pane); setMachine(machine); };
  window.qa.refresh = () => mediator.dispatch({ type: "chat-delivered" });
  return <><button id="fetch-output" onClick={() => { output.load(); output.load(); }}>Load output</button><output id="output">{output.state}:{output.text}</output>
    <div style={{ position: "relative", height: 600 }}><MachineContext.Provider value={machine}><ChatPresenter key={machine} paneId={pane} connected={false} ended={false} agent={null} agentStatus={undefined} emit={mediator.dispatch} /></MachineContext.Provider></div></>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><MediatorContext.Provider value={mediator}><SettingsProvider settings={loadSettings()} onChange={() => {}}><Fixture /></SettingsProvider></MediatorContext.Provider></React.StrictMode>);
