/**
 * A yes-or-no question before something that cannot be undone. Cancel takes the focus, so Enter
 * answers no; Escape and the scrim answer no as well, and Tab stays between the two buttons. A
 * no gives the focus back to what opened the dialog; after a yes the owner decides, since the
 * row that opened it is usually gone. The owner runs the action: while it runs both buttons wait,
 * and a failure comes back as `error`.
 */
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import "./ConfirmDialog.css";

import { useT } from "../lib/i18n.ts";

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  /** the deed runs: the owner takes the dialog down once it is done */
  pending: boolean;
  /** why the last yes failed */
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({ title, body, confirmLabel, pending, error, onConfirm, onClose }: Props) {
  const t = useT();
  const id = useId();
  const surface = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // taken down while the deed ran: it was done, and the owner places the focus
  const running = useRef(pending);
  running.current = pending;

  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (!running.current && opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { window.requestAnimationFrame(() => cancel.current?.focus()); }, []);
  // both buttons disable while the deed runs, which would drop the focus into the page: the
  // dialog itself holds it, and Tab stays put until the dialog goes
  useEffect(() => { if (pending) surface.current?.focus(); }, [pending]);
  // Escape is this dialog's while it is up, even while the deed runs and cannot be undone
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      if (!pending) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    if (pending) return;
    (document.activeElement === cancel.current ? action.current : cancel.current)?.focus();
  };

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
      <div ref={surface} className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} tabIndex={-1} onKeyDown={onKeyDown}>
        <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{title}</h2></header>
        <div className="modal-body">
          <p className="confirm-body" id={`${id}-body`}>{body}</p>
          {error && <p className="confirm-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button ref={cancel} type="button" className="btn" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
          <button ref={action} type="button" className="btn btn-danger" disabled={pending} onClick={onConfirm}>{confirmLabel}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
