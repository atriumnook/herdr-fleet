import { readlinkSync } from "node:fs";
import { herdrRpc } from "./herdr/client.ts";

export interface Grid { cols: number; rows: number }

/** `stty size` prints "rows cols". */
export function parseSttySize(text: string): Grid | null {
  const match = /^(\d+) (\d+)\s*$/.exec(text);
  if (!match) return null;
  const rows = Number(match[1]);
  const cols = Number(match[2]);
  return rows > 0 && cols > 0 ? { cols, rows } : null;
}

/**
 * The grid the pane's terminal has now, read from its tty. herdr's API reports the pane's
 * rect, borders included (2 or 3 cells more than the terminal, or none for a lone pane), and
 * its rows, never its columns. null where /proc is missing (not Linux) or the shell is gone.
 */
export async function paneGrid(paneId: string): Promise<Grid | null> {
  const info = await herdrRpc<{ process_info?: { shell_pid?: number } }>("pane.process_info", { pane_id: paneId });
  const pid = info.process_info?.shell_pid;
  if (!pid) return null;
  let tty: string;
  try { tty = readlinkSync(`/proc/${pid}/fd/0`); } catch { return null; }
  if (!tty.startsWith("/dev/pts/")) return null;
  const stty = Bun.spawn(["stty", "-F", tty, "size"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [text, code] = await Promise.all([new Response(stty.stdout).text(), stty.exited]);
  return code === 0 ? parseSttySize(text) : null;
}
