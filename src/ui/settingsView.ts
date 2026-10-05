import type { Settings } from "../lib/settings.ts";
import { isLoopbackHost, phonePlan, type PageLocation, type PhonePlan } from "../lib/phone.ts";
import type { FontField, UiState } from "./state.ts";

/** What the Settings dialog draws, built from the Mediator's state and the page's own address. */
export interface SettingsDialogModel {
  settings: Settings;
  /** the font lists as shown: what is being typed, else what is set */
  fonts: Record<FontField, string>;
  phone: { plan: PhonePlan; loading: boolean };
  /** where a phone can open this app now, for the pairing QR code */
  pairUrl: string | null;
}

/** The dialog's values while it is open; null while it is closed. */
export function settingsDialogModel(state: UiState, page: PageLocation): SettingsDialogModel | null {
  const dialog = state.settingsDialog;
  if (!dialog.open) return null;
  const plan = phonePlan(page, state.remoteAccess.data);
  return {
    settings: state.settings,
    fonts: {
      terminalFontFamily: dialog.drafts.terminalFontFamily ?? state.settings.terminalFontFamily,
      chatFontFamily: dialog.drafts.chatFontFamily ?? state.settings.chatFontFamily,
    },
    phone: { plan, loading: state.remoteAccess.status === "loading" || state.remoteAccess.status === "idle" },
    // the served address, else this one when it is not loopback
    pairUrl: plan.kind === "here" || plan.kind === "served" ? plan.url : isLoopbackHost(page.hostname) ? null : page.origin,
  };
}
