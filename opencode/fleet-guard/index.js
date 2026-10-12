// Loaded by herdr-fleet into the panes of roles that edit no file (guard.js says why).
// An OpenCode 2 plugin: a tool.execute.before hook that fails the call with a Tool.Error.
import { Effect } from "effect";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { refusal } from "./guard.js";

export default {
  id: "herdr-fleet.guard",
  effect: (ctx) =>
    ctx.tool
      .hook("execute.before", (event) => {
        const message = refusal(event.tool, event.input);
        return message ? Effect.fail(new ToolError({ message })) : Effect.void;
      })
      .pipe(Effect.asVoid),
};
