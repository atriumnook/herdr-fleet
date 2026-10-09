/**
 * UI text. Labels (names, buttons, states, headings, counts) stay in English; sentences read
 * word for word (setting descriptions, error and notice bodies, confirmations, guidance) are
 * Japanese. The English string is the key: `t("Rename pane")`, `t("Token does not match.")`.
 * A sentence ends with a full stop (see isSentence), and only sentences have an entry in
 * i18n.ja.ts; src/lib/i18n.test.ts scans the code for every `t("…")` and fails when a sentence
 * lacks its Japanese or a label has one. There is no language setting.
 */
import { JA } from "./i18n.ja.ts";

/** The tag for `<html lang>` and Intl formatting: the sentences are Japanese. */
export const LOCALE = "ja-JP";

/**
 * Whether `key` is a sentence, the only kind of text that is translated: it ends with a full
 * stop, or with a full stop and then the detail it reports (`Could not close. {reason}`).
 */
export function isSentence(key: string): boolean {
  return /\.(?: \{\w+\})?$/.test(key);
}

export type Vars = Record<string, string | number>;

/** The text for `key`, placeholders filled: the Japanese of a sentence, a label as it is. */
export function t(key: string, vars?: Vars): string {
  const text = JA[key] ?? key;
  return vars === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}
