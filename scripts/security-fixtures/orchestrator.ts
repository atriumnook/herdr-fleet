/** The decisions orchestrator takes over (format.ts): what an OpenCode pane is given. */
import { opencodeConfig, opencodeGitEnv, type OpencodeRole } from "../../server/fleet/opencode-config.ts";
import type { Decision, Env } from "./format.ts";

export const orchestratorDecisions: Record<string, Decision> = {
  opencodeGitEnv: (env: Env) => opencodeGitEnv(env),
  opencodeConfig: (role: OpencodeRole) => opencodeConfig(role),
};
