/** Where app state lives: devices, push keys and subscriptions, completion state. */
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultStateDir(): string {
  const override = process.env["HERDR_FLEET_STATE_DIR"];
  if (override) return override;
  return join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr-fleet");
}
