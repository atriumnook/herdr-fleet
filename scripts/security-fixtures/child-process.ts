/** The decisions child-process takes over (format.ts): the environment of a CLI the server starts on its own. */
import { childEnv, claudeEnv } from "../../server/cli-child.ts";
import type { Decision, Env } from "./format.ts";

export const childProcessDecisions: Record<string, Decision> = {
  childEnv: ({ env, alsoKeep }: { env: Env; alsoKeep?: string[] }) => alsoKeep === undefined ? childEnv(env) : childEnv(env, alsoKeep),
  claudeEnv: (env: Env) => claudeEnv(env),
};
