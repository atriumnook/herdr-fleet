/**
 * The disconnected-input draft: while the socket is down, typed text is held for the
 * user to review and send after reconnect instead of being queued and fired blindly.
 * Pure logic, DOM-free, so the policy is unit-testable (see draft.test.ts).
 */

export interface InputDraft {
  readonly text: string;
  /** special keys (Enter, arrows, ^C, ...) received while disconnected - undraftable, counted */
  readonly droppedSpecial: number;
}

export const EMPTY_DRAFT: InputDraft = { text: "", droppedSpecial: 0 };

const MAX_DRAFT_CHARS = 1024;

/** An IME commit can contain several code points. Never preserve terminal control sequences. */
function isPrintableChar(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f-\x9f]/u.test(data);
}

/** Folds one onData chunk into the draft: printable text accumulates, special keys count. */
export function applyToDraft(draft: InputDraft, data: string): InputDraft {
  if (!isPrintableChar(data)) {
    // Enter, arrows and bracketed paste frames contain controls; keep only plain text.
    return { ...draft, droppedSpecial: draft.droppedSpecial + 1 };
  }
  if (draft.text.length + data.length > MAX_DRAFT_CHARS) {
    return { ...draft, droppedSpecial: draft.droppedSpecial + 1 };
  }
  return { ...draft, text: draft.text + data };
}

export function draftIsEmpty(draft: InputDraft): boolean {
  return draft.text.length === 0 && draft.droppedSpecial === 0;
}

/**
 * What a key typed into a pane that holds a draft does. Keys sent beside it would reach the pty
 * without the start the draft holds (`echo ` held, then `rm -rf build` and Enter typed), so until
 * Send or Discard text, a paste, Backspace and anything with a line break go to the draft, which
 * leaves Enter out: a partial command never runs. Other control keys (Ctrl+C, Escape, Tab, arrows)
 * still reach the program: an interrupt must not wait on the draft.
 */
export function besideHeldDraft(input: string): "hold" | "send" {
  return input.startsWith("\x1b[200~") || /[\r\n\x7f\b]/.test(input) || isPrintableChar(input) ? "hold" : "send";
}

/** A draft holds the start of a line: what is typed next belongs after it (besideHeldDraft). */
export function draftHoldsText(draft: InputDraft): boolean {
  return draft.text.length > 0;
}
