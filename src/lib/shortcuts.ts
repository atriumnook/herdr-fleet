import { useEffect } from "react";
import { useSettings } from "./settings.ts";
import type { ShortcutOverrides } from "./shortcutBindings.ts";

import type { AppActions } from "./actions.ts";

export const SHORTCUTS = [
  { id: "palette", label: "Command palette", keys: ["Mod", "Shift", "K"] },
  { id: "toggle-view", label: "Switch chat / terminal", keys: ["Mod", "Shift", "J"] },
  { id: "toggle-sidebar", label: "Toggle sidebar", keys: ["Mod", "Shift", "B"] },
  // Mod+Shift+N keeps working where the browser lets it through (the installed app), but Chrome
  // keeps Ctrl+Shift+N for a new incognito window in a tab: O is the one shown, and works in both
  { id: "new-session", label: "New session", keys: ["Mod", "Shift", "O"] },
  { id: "previous-pane", label: "Previous pane", keys: ["Mod", "Shift", "ArrowUp"] },
  { id: "next-pane", label: "Next pane", keys: ["Mod", "Shift", "ArrowDown"] },
  { id: "previous-prompt", label: "Previous prompt", keys: ["Mod", "Shift", "["] },
  { id: "next-prompt", label: "Next prompt", keys: ["Mod", "Shift", "]"] },
  { id: "settings", label: "Settings", keys: ["Mod", "Shift", ","] },
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

export interface ShortcutEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

const KEY_TO_ID: Readonly<Record<string, ShortcutId>> = {
  k: "palette",
  j: "toggle-view",
  b: "toggle-sidebar",
  n: "new-session",
  o: "new-session",
  ArrowUp: "previous-pane",
  ArrowDown: "next-pane",
  "[": "previous-prompt",
  "]": "next-prompt",
  ",": "settings",
};

/** Shift turns the bracket keys into braces on common layouts (US and Japanese alike) */
const SHIFTED: Readonly<Record<string, string>> = { "{": "[", "}": "]" };

export function shortcutKeys(id: ShortcutId, overrides: ShortcutOverrides): string[] {
  if (Object.hasOwn(overrides, id)) return overrides[id] ? [overrides[id]!] : [];
  return Object.entries(KEY_TO_ID).filter(([, action]) => action === id).map(([key]) => key);
}
export function shortcutConflict(id: ShortcutId, keys: string[], overrides: ShortcutOverrides): boolean {
  return SHORTCUTS.some((other) => other.id !== id && shortcutKeys(other.id, overrides).some((key) => keys.includes(key)));
}

export function matchShortcut(event: ShortcutEventLike, platformIsMac: boolean, overrides: ShortcutOverrides = {}): ShortcutId | null {
  if (event.isComposing || event.keyCode === 229) return null;
  const hasMod = platformIsMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!hasMod || !event.shiftKey || event.altKey) return null;
  // Shift+Comma produces "<" on common keyboard layouts.
  const key = event.code === "Comma" ? "," : /^Digit[0-9]$/.test(event.code ?? "") ? event.code!.slice(-1) : event.key.length === 1 ? SHIFTED[event.key] ?? event.key.toLowerCase() : event.key;
  for (const shortcut of SHORTCUTS) {
    if (Object.hasOwn(overrides, shortcut.id) && overrides[shortcut.id] === key) return shortcut.id;
  }
  const id = KEY_TO_ID[key];
  return id && !Object.hasOwn(overrides, id) ? id : null;
}

/**
 * Mod+Shift+ArrowUp/ArrowDown move the selection in a text field (on a Mac Cmd+Shift+↑ selects to
 * the start of the text): in the message box or any other field they stay the field's, and switch
 * panes everywhere else, the terminal included (its own input element is xterm's, not a field to edit).
 */
export interface KeyTargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  classList?: { contains(name: string): boolean };
}

export function keepsArrowsForText(target: KeyTargetLike | EventTarget | null): boolean {
  if (target === null || typeof target !== "object" || !("tagName" in target)) return false;
  const element = target as KeyTargetLike;
  if (element.classList?.contains("xterm-helper-textarea")) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = element.type ?? "";
  return type === "text" || type === "search" || type === "url" || type === "email" || type === "password" || type === "tel" || type === "number" || type === "";
}

/** the shortcuts that step through a chat's prompts: they are the app's only while a chat shows */
const PROMPT_STEPS: ReadonlySet<ShortcutId> = new Set(["previous-prompt", "next-prompt"]);

/**
 * The capture listener below only prevents the browser's default, so xterm would still encode an
 * app shortcut for the pane: its key handler asks this first. A terminal holding the keyboard
 * shows no chat, so the prompt steps stay its keys.
 */
export function isAppShortcut(event: ShortcutEventLike, overrides: ShortcutOverrides = {}): boolean {
  const shortcut = matchShortcut(event, isMacPlatform(), overrides);
  return shortcut !== null && !PROMPT_STEPS.has(shortcut);
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

export function modKeyLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

export function formatKeys(keys: readonly string[]): string[] {
  const mod = modKeyLabel();
  return keys.map((key) => (key === "Mod" ? mod : key));
}

export function useShortcuts(actions: AppActions, enabled: boolean): void {
  const { settings } = useSettings();
  useEffect(() => {
    if (!enabled) return;
    const platformIsMac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.target as HTMLElement | null)?.closest?.("[data-shortcut-recorder]")) return;
      const shortcut = matchShortcut(event, platformIsMac, settings.shortcutOverrides);
      if (shortcut === null) return;
      if (event.key.startsWith("Arrow") && keepsArrowsForText(event.target)) return;
      // with no chat showing there is no prompt to step to: the keys go on to whatever has the focus
      if (PROMPT_STEPS.has(shortcut) && actions.stepPrompt === null) return;
      event.preventDefault();
      switch (shortcut) {
        case "palette":
          actions.openPalette();
          break;
        case "toggle-view":
          actions.toggleView();
          break;
        case "toggle-sidebar":
          actions.toggleSidebar();
          break;
        case "new-session":
          actions.openNewSession();
          break;
        case "previous-pane":
          actions.selectAdjacentPane(-1);
          break;
        case "next-pane":
          actions.selectAdjacentPane(1);
          break;
        case "previous-prompt":
          actions.stepPrompt?.(-1);
          break;
        case "next-prompt":
          actions.stepPrompt?.(1);
          break;
        case "settings":
          actions.openSettings();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [actions, enabled, settings.shortcutOverrides]);
}
