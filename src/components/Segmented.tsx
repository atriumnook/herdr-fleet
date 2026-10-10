import type { KeyboardEvent, ReactNode } from "react";

const KEYS: Readonly<Record<string, "next" | "previous" | "first" | "last">> = {
  ArrowRight: "next", ArrowDown: "next", ArrowLeft: "previous", ArrowUp: "previous", Home: "first", End: "last",
};

/** Where a key moves among `count` options from `index`: arrows wrap, Home and End jump; null for any other key. */
export function nextOption(key: string, index: number, count: number): number | null {
  const move = KEYS[key];
  if (!move || count === 0) return null;
  if (move === "first") return 0;
  if (move === "last") return count - 1;
  const from = index < 0 ? 0 : index;
  return (from + (move === "next" ? 1 : -1) + count) % count;
}

function moveAmongOptions(event: KeyboardEvent<HTMLDivElement>): void {
  const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)")];
  const next = nextOption(event.key, options.indexOf(document.activeElement as HTMLButtonElement), options.length);
  if (next === null) return;
  event.preventDefault();
  options[next]!.focus();
}

/**
 * A segmented control: one chosen option among two to four, each a button with `aria-pressed`.
 * The arrow keys move between the options (Home and End to either end); Enter or Space chooses.
 */
export function Segmented({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className ? `segmented ${className}` : "segmented"} role="group" aria-label={label} onKeyDown={moveAmongOptions}>
      {children}
    </div>
  );
}
