import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Monitor, Plus, Star, X } from "lucide-react";

import "./SettingsDialog.css";

import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { SHORTCUTS, formatKeys, shortcutKeys, shortcutConflict } from "../lib/shortcuts.ts";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, chatFontSize, DEFAULT_SETTINGS, QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN, TERMINAL_WHEEL_SPEED_MAX, TERMINAL_WHEEL_SPEED_MIN, useSettings, forgetPaneViews } from "../lib/settings.ts";
import { LANGUAGE_NAMES, LANGUAGE_SETTINGS, useT } from "../lib/i18n.ts";
import { FONT_FAMILY_MAX_CHARS, sanitizeFontFamily } from "../lib/fontFamily.ts";
import type { UpdatesModel } from "../lib/updates.ts";
import type { MachineSettings } from "../../shared/machines.ts";
import { fetchRemoteAccess, machineRequest } from "../lib/api.ts";
import { isLoopbackHost, phonePlan } from "../lib/phone.ts";
import type { HealthAuth, RemoteAccess } from "../../shared/protocol.ts";
import { DevicesPanel } from "./DevicesPanel.tsx";
import { PhonePanel } from "./PhonePanel.tsx";
import { PushTestControls } from "./PushTestControls.tsx";
import { HerdrUpdateControls, UpdateControls } from "./UpdateControls.tsx";

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  actions: AppActions;
  updates: UpdatesModel;
  /** how this browser got in, from the last health check */
  auth: HealthAuth | null;
  onEnableNotifications: () => Promise<boolean>;
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button type="button" className="settings-toggle" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <span className="settings-toggle-thumb" />
    </button>
  );
}

function compactKeys(keys: readonly string[]): string {
  return formatKeys(keys).map((key) => ({ Shift: "⇧", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" }[key] ?? (key.length === 1 ? key.toUpperCase() : key))).join("+");
}

const FONT_FAMILY_PLACEHOLDER = 'D2Coding, "Cascadia Mono"';

/**
 * A font family list, saved when the field is left, on Enter or when the dialog closes: saving
 * every keystroke would sanitize away the comma or space being typed, and each change of the
 * terminal's font refits the grid and resizes the pane.
 */
function FontFamilyInput({ value, label, onCommit }: { value: string; label: string; onCommit: (family: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    const next = sanitizeFontFamily(draft);
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  // closing the dialog with Escape unmounts the field without a blur
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);
  return (
    <input
      className="input settings-font-input"
      value={draft}
      placeholder={FONT_FAMILY_PLACEHOLDER}
      maxLength={FONT_FAMILY_MAX_CHARS}
      aria-label={label}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        // an IME keeps its Enter, including the committing one WebKit can send after compositionend as key code 229
        if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        commit();
      }}
    />
  );
}

export function SettingsDialog({ open, onClose, actions, updates, auth, onEnableNotifications }: SettingsDialogProps) {
  const { settings, update } = useSettings();
  const t = useT();
  const installPrompt = useInstallPrompt();
  const firstControlRef = useRef<HTMLButtonElement>(null);
  // server-side: the web server updates PC bridges, so it keeps this choice
  const [pcSettings, setPcSettings] = useState<MachineSettings | null>(null);
  const [pcSettingsError, setPcSettingsError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    machineRequest<MachineSettings>("/settings").then(setPcSettings, () => setPcSettings(null));
  }, [open]);
  // Settings → Phone asks the server what Tailscale on its PC already serves
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  const loadAccess = useCallback(() => {
    setAccess(undefined);
    fetchRemoteAccess().then(setAccess, () => setAccess(null));
  }, []);
  useEffect(() => { if (open) loadAccess(); }, [open, loadAccess]);
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext }, access ?? null);
  // where a phone can open this app now, for the pairing QR code: the served address, else this one when it is not loopback
  const pairUrl = plan.kind === "here" || plan.kind === "served" ? plan.url : isLoopbackHost(window.location.hostname) ? null : window.location.origin;

  const updatePcSettings = async (patch: Partial<MachineSettings>) => {
    try { setPcSettings(await machineRequest<MachineSettings>("/settings", "PATCH", patch)); setPcSettingsError(null); }
    catch (e) { setPcSettingsError(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => {
    if (!open) return;
    firstControlRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-header">
          <h2 className="modal-title" id="settings-title">{t("Settings")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close settings")} onClick={onClose}><X /></button>
        </header>
        <div className="modal-body settings-body">
          <section className="settings-section">
            <h3>{t("Appearance")}</h3>
            <div className="settings-row">
              <div><span className="settings-label">{t("Theme")}</span><span className="settings-description">{t("Choose the app color scheme")}</span></div>
              <div className="segmented" aria-label={t("Theme")}>
                {(["dark", "light", "system"] as const).map((theme, index) => (
                  <button key={theme} ref={index === 0 ? firstControlRef : undefined} type="button" aria-pressed={settings.theme === theme} onClick={() => update({ theme })}>
                    {t(theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System")}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Colors")}</span><span className="settings-description">{t("herdr's amber, a dark report, or neutral charcoal")}</span></div>
              <div className="segmented" aria-label={t("Colors")}>
                {(["amber", "report", "charcoal"] as const).map((palette) => (
                  <button key={palette} type="button" aria-pressed={settings.palette === palette} onClick={() => update({ palette })}>
                    {t(palette === "report" ? "Dark report" : palette === "amber" ? "Amber" : "Charcoal")}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Density")}</span><span className="settings-description">{t("Adjust spacing throughout the interface")}</span></div>
              <div className="segmented" aria-label={t("Density")}>
                {(["comfortable", "compact"] as const).map((density) => (
                  <button key={density} type="button" aria-pressed={settings.density === density} onClick={() => update({ density })}>
                    {t(density === "compact" ? "Compact" : "Comfortable")}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Language")}</span><span className="settings-description">{t("Follows the browser unless you choose one")}</span></div>
              <div className="segmented" aria-label={t("Language")}>
                {LANGUAGE_SETTINGS.map((language) => (
                  <button key={language} type="button" aria-pressed={settings.language === language} onClick={() => update({ language })}>
                    {language === "system" ? t("System") : LANGUAGE_NAMES[language]}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Sidebar grouping")}</span><span className="settings-description">{t("Group sessions by workspace or by full folder path on each PC")}</span></div>
              <div className="segmented" aria-label={t("Sidebar grouping")}>
                {(["workspace", "directory"] as const).map((grouping) => (
                  <button key={grouping} type="button" aria-pressed={settings.sidebarGrouping === grouping} onClick={() => update({ sidebarGrouping: grouping })}>
                    {t(grouping === "workspace" ? "By workspace" : "By folder")}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Terminal font size")}</span><span className="settings-description">{t("Applied to every terminal pane")}</span></div>
              <div className="settings-stepper" aria-label={t("Terminal font size")}>
                <button type="button" className="icon-button" aria-label={t("Decrease terminal font size")} disabled={settings.terminalFontSize <= TERMINAL_FONT_MIN} onClick={() => update({ terminalFontSize: settings.terminalFontSize - 1 })}><Minus /></button>
                <output aria-live="polite">{settings.terminalFontSize}px</output>
                <button type="button" className="icon-button" aria-label={t("Increase terminal font size")} disabled={settings.terminalFontSize >= TERMINAL_FONT_MAX} onClick={() => update({ terminalFontSize: settings.terminalFontSize + 1 })}><Plus /></button>
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Terminal font")}</span><span className="settings-description">{t("Comma-separated, tried in order. A font this device does not have falls back to the default.")}</span></div>
              <FontFamilyInput value={settings.terminalFontFamily} label={t("Terminal font")} onCommit={(terminalFontFamily) => update({ terminalFontFamily })} />
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Wheel scroll speed")}</span><span className="settings-description">{t("How far one turn of the wheel scrolls the terminal")}</span></div>
              <div className="settings-stepper" aria-label={t("Wheel scroll speed")}>
                <button type="button" className="icon-button" aria-label={t("Slower wheel scrolling")} disabled={settings.terminalWheelSpeed <= TERMINAL_WHEEL_SPEED_MIN} onClick={() => update({ terminalWheelSpeed: settings.terminalWheelSpeed - 1 })}><Minus /></button>
                <output aria-live="polite">{settings.terminalWheelSpeed}×</output>
                <button type="button" className="icon-button" aria-label={t("Faster wheel scrolling")} disabled={settings.terminalWheelSpeed >= TERMINAL_WHEEL_SPEED_MAX} onClick={() => update({ terminalWheelSpeed: settings.terminalWheelSpeed + 1 })}><Plus /></button>
              </div>
            </div>
            <div className="settings-row"><label htmlFor="terminal-input-mode">{t("Terminal input mode")}</label>
              <select id="terminal-input-mode" className="input" value={settings.terminalInputMode} onChange={(event) => update({ terminalInputMode: event.target.value as "auto" | "line" | "direct" })}>
                <option value="auto">{t("Automatic")}</option><option value="line">{t("Input line")}</option><option value="direct">{t("Direct typing")}</option>
              </select>
            </div>
          </section>

          <section className="settings-section">
            <h3>{t("Composer")}</h3>
            <div className="settings-row">
              <div><span className="settings-label">{t("Enter sends")}</span><span className="settings-description">{t("When off, Mod+Enter sends")}</span></div>
              <Toggle label={t("Enter sends")} checked={settings.enterSends} onChange={(enterSends) => update({ enterSends })} />
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Suggestion chip")}</span><span className="settings-description">{t("On a touch screen, a chip above the message box puts the prompt Claude Code suggests next into the box. With a keyboard, Tab does it.")}</span></div>
              <Toggle label={t("Suggestion chip")} checked={settings.showSuggestionChip} onChange={(showSuggestionChip) => update({ showSuggestionChip })} />
            </div>
          </section>

          <section className="settings-section">
            <h3>{t("Chat")}</h3>
            <div className="settings-row">
              <div><span className="settings-label">{t("Panes open in")}</span><span className="settings-description">{t("Every pane on this device. Switching a pane's lens keeps it there until this changes. Auto: chat for an agent on a touch screen, else the terminal.")}</span></div>
              <div className="segmented" aria-label={t("Panes open in")}>
                {(["auto", "chat", "terminal"] as const).map((defaultView) => (
                  <button key={defaultView} type="button" aria-pressed={settings.defaultView === defaultView} onClick={() => {
                    if (settings.defaultView === defaultView) return;
                    // one choice for every pane: what each one remembered gives way to it
                    forgetPaneViews();
                    update({ defaultView });
                  }}>
                    {t(defaultView === "auto" ? "Auto" : defaultView === "chat" ? "Chat" : "Terminal")}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Show thinking")}</span><span className="settings-description">{t("Include the agent's reasoning blocks")}</span></div>
              <Toggle label={t("Show thinking")} checked={settings.showThinking} onChange={(showThinking) => update({ showThinking })} />
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Chat font size")}</span><span className="settings-description">{t("Messages, code and prompt cards in the chat view")}</span></div>
              <div className="settings-stepper" aria-label={t("Chat font size")}>
                <button type="button" className="icon-button" aria-label={t("Decrease chat font size")} disabled={chatFontSize(settings) <= CHAT_FONT_MIN} onClick={() => update({ chatFontSize: chatFontSize(settings) - 1 })}><Minus /></button>
                <output aria-live="polite">{chatFontSize(settings)}px</output>
                <button type="button" className="icon-button" aria-label={t("Increase chat font size")} disabled={chatFontSize(settings) >= CHAT_FONT_MAX} onClick={() => update({ chatFontSize: chatFontSize(settings) + 1 })}><Plus /></button>
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Chat font")}</span><span className="settings-description">{t("Message text; code stays monospace. Comma-separated, tried in order. A font this device does not have falls back to the default.")}</span></div>
              <FontFamilyInput value={settings.chatFontFamily} label={t("Chat font")} onCommit={(chatFontFamily) => update({ chatFontFamily })} />
            </div>
          </section>

          <section className="settings-section">
            <h3>{t("Alerts")}</h3>
            <p className="settings-description">{t("For this device. An alert waits a little first, and none comes when the pane changes meanwhile, as when you answer at the PC.")}</p>
            <PushTestControls onEnable={onEnableNotifications} />
            <div className="settings-row">
              <div><span className="settings-label">{t("Needs input")}</span><span className="settings-description">{t("An agent waits for an answer or a permission")}</span></div>
              <Toggle label={t("Needs input")} checked={settings.alertInput} onChange={(alertInput) => update({ alertInput })} />
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Finished")}</span><span className="settings-description">{t("Long turns: only work that took a minute or more")}</span></div>
              <div className="segmented" aria-label={t("Finished")}>
                {(["off", "long", "always"] as const).map((alertDone) => (
                  <button key={alertDone} type="button" aria-pressed={settings.alertDone === alertDone} onClick={() => update({ alertDone })}>
                    {t(alertDone === "off" ? "Off" : alertDone === "long" ? "Long turns" : "Every turn")}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("In the app")}</span><span className="settings-description">{t("While the app is open, these drop in from the top of the screen at once. Tap one to open its pane.")}</span></div>
              <Toggle label={t("In the app")} checked={settings.alertInApp} onChange={(alertInApp) => update({ alertInApp })} />
            </div>
          </section>

          <section className="settings-section">
            <h3>{t("Quick replies")}</h3>
            <div className="settings-row">
              <div><span className="settings-label">{t("Show above the message box")}</span><span className="settings-description">{t("One-tap messages above the message box, on this device. Each is sent as if typed: queued while the agent works, an answer when a question is open.")}</span></div>
              <Toggle label={t("Show above the message box")} checked={settings.showQuickReplies} onChange={(showQuickReplies) => update({ showQuickReplies })} />
            </div>
            <ol className="quick-replies-list">
              {settings.quickReplies.map((reply, index) => (
                <li key={index}>
                  <input
                    className="input"
                    value={reply}
                    maxLength={QUICK_REPLY_MAX_CHARS}
                    aria-label={t("Quick reply {number}", { number: index + 1 })}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    onChange={(event) => update({ quickReplies: settings.quickReplies.map((current, at) => at === index ? event.target.value : current) })}
                  />
                  <button type="button" className="icon-button" aria-label={t("Remove quick reply {number}", { number: index + 1 })} onClick={() => update({ quickReplies: settings.quickReplies.filter((_, at) => at !== index) })}>
                    <X aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
            <div className="phone-actions">
              <button type="button" className="btn" disabled={settings.quickReplies.length >= QUICK_REPLIES_MAX} onClick={() => update({ quickReplies: [...settings.quickReplies, ""] })}><Plus aria-hidden="true" />{t("Add reply")}</button>
              <button type="button" className="btn btn-ghost" onClick={() => update({ quickReplies: [...DEFAULT_SETTINGS.quickReplies] })}>{t("Restore defaults")}</button>
            </div>
          </section>

          <section className="settings-section">
            <h3>{t("Shortcuts")}</h3>
            <p className="settings-description">{t("Some keys are reserved by the browser. Changes apply to this device.")}</p>
            <button className="btn" onClick={() => update({ shortcutOverrides: {} })}>{t("Reset shortcuts")}</button>
            <table className="settings-shortcuts">
              <tbody>{SHORTCUTS.map((shortcut) => (
                <tr key={shortcut.id}><th scope="row">{t(shortcut.label)}</th><td><select className="input" aria-label={t(shortcut.label)} value={Object.hasOwn(settings.shortcutOverrides, shortcut.id) ? settings.shortcutOverrides[shortcut.id] ?? "off" : "default"} onChange={(event) => {
                  const next = { ...settings.shortcutOverrides };
                  if (event.target.value === "default") delete next[shortcut.id];
                  else next[shortcut.id] = event.target.value === "off" ? null : event.target.value;
                  update({ shortcutOverrides: next });
                }}>
                  <option value="default" title={t("Default")} disabled={shortcutConflict(shortcut.id, shortcutKeys(shortcut.id, {}), settings.shortcutOverrides)}>{compactKeys(shortcut.keys)}</option>
                  <option value="off" title={t("Send keys to terminal")}>{t("Off")}</option>
                  {[..."abcdefghijklmnopqrstuvwxyz0123456789,", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].map((key) => {
                    const conflict = shortcutConflict(shortcut.id, [key], settings.shortcutOverrides);
                    return <option key={key} value={key} disabled={conflict}>{compactKeys(["Mod", "Shift", key])}{conflict ? " — " + t("Already assigned") : ""}</option>;
                  })}
                </select></td></tr>
              ))}</tbody>
            </table>
          </section>

          <section className="settings-section">
            <h3>{t("Phone")}</h3>
            <div className="settings-row">
              <div><span className="settings-label">{t("Keep screen on")}</span><span className="settings-description">{t("While a terminal or chat pane is open. Requires HTTPS or localhost and a supported browser.")}</span></div>
              <Toggle label={t("Keep screen on")} checked={settings.keepScreenOn} onChange={(keepScreenOn) => update({ keepScreenOn })} />
            </div>
            <PhonePanel plan={plan} loading={access === undefined} onRefresh={loadAccess} />
          </section>

          <section className="settings-section">
            <h3>{t("Devices")}</h3>
            <DevicesPanel pairUrl={pairUrl} auth={auth} />
          </section>

          <section className="settings-section">
            <h3>{t("Remote PCs")}</h3>
            <div className="settings-row">
              <div><span className="settings-label">{t("Add PC")}</span><span className="settings-description">{t("Connect another PC over an SSH alias or user@host. Its workspaces join the sidebar.")}</span></div>
              <button type="button" className="btn" onClick={actions.openAddPc}><Monitor aria-hidden="true" />{t("Add PC")}</button>
            </div>
            {/* the switch is the server's and waits for its answer; Add PC never does */}
            {pcSettings && <div className="settings-row">
              <div><span className="settings-label">{t("Update PC bridges automatically")}</span><span className="settings-description">{t("When an app update needs a newer bridge, PCs that connect with their saved key are updated in the background. PCs that need a password ask first.")}</span></div>
              <Toggle label={t("Update PC bridges automatically")} checked={pcSettings.auto_update_bridges} onChange={(auto_update_bridges) => void updatePcSettings({ auto_update_bridges })} />
            </div>}
            {pcSettingsError && <p className="settings-hint" role="alert">{pcSettingsError}</p>}
          </section>

          <section className="settings-section">
            <h3>{t("Install")}</h3>
            {installPrompt.installed ? <p className="settings-hint">{t("Installed")}</p> : installPrompt.canInstall ? (
              <button type="button" className="btn btn-primary" onClick={() => void installPrompt.install()}>{t("Install app")}</button>
            ) : <p className="settings-hint">{installPrompt.help}</p>}
          </section>

          <section className="settings-section settings-about">
            <h3>{t("About")}</h3>
            <p><strong>herdr web ui</strong></p>
            <a className="btn" href="https://github.com/devswha/herdr-web-ui" target="_blank" rel="noreferrer"><Star aria-hidden="true" />{t("Star on GitHub")}</a>
            <a href="https://devswha.github.io/herdr-web-ui/" target="_blank" rel="noreferrer">devswha.github.io/herdr-web-ui</a>
          </section>
          <UpdateControls updates={updates} bridgesFollow={pcSettings?.auto_update_bridges === true} />
          <HerdrUpdateControls enabled={open} />
        </div>
      </section>
    </div>
  );
}
