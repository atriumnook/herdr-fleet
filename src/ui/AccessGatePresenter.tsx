import { AccessGate, type AccessGateEvent } from "../components/AccessGate.tsx";
import type { Emit } from "./bubble.ts";
import { useSelected } from "./presenter.ts";

/** The sign-in screen's Presenter: why the server refused this browser, and what the gate holds. */
export function AccessGatePresenter({ emit }: { emit: Emit<AccessGateEvent> }) {
  const reason = useSelected((state) => state.connection.reason);
  const gate = useSelected((state) => state.gate);
  return <AccessGate reason={reason} gate={gate} emit={emit} />;
}
