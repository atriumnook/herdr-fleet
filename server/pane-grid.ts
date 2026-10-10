import { readFileSync } from "node:fs";
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
 * The pseudo-terminal a process has as its controlling terminal, from its /proc/<pid>/stat:
 * the tty_nr field (the 7th; the command name before it is in parentheses and may hold spaces)
 * is the device number, and a pty's (majors 136-143) names /dev/pts/<n>.
 */
export function controllingPts(stat: string): string | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const device = Number(fields[4]);
  if (!Number.isInteger(device) || device <= 0) return null;
  const major = (device >> 8) & 0xfff;
  const minor = (device & 0xff) | ((device >> 12) & 0xfff00);
  return major >= 136 && major <= 143 ? `/dev/pts/${(major - 136) * 256 + minor}` : null;
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
  // the controlling terminal, not fd 0: a shell points its fds at /dev/null while its startup
  // and prompt hooks run
  let tty: string | null;
  try { tty = controllingPts(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return null; }
  if (!tty) return null;
  const stty = Bun.spawn(["stty", "-F", tty, "size"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [text, code] = await Promise.all([new Response(stty.stdout).text(), stty.exited]);
  return code === 0 ? parseSttySize(text) : null;
}
