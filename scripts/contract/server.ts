/**
 * The TypeScript server's test entry point (ADR 0122-parity-criteria): reads the test options as
 * JSON on standard input, hands them to createServer, and leaves the rest of the configuration
 * to createServer, which reads it from the environment as production does. Not in server/,
 * where the crate-split check of ADR 0107 counts every file.
 *
 * Out: one line `{"listening":{"hostname":…,"port":…}}` once it listens. SIGTERM stops it as
 * production does (server/index.ts). An option outside the table: its name on standard error, exit 2.
 */
import { createServer } from "../../server/index.ts";
import { loopbackPush } from "../../server/push.fake.ts";
import { parseTestOptions, type TestOptions } from "./spec.ts";

let test: TestOptions;
try {
  const input = (await Bun.stdin.text()).trim();
  test = parseTestOptions(input === "" ? {} : JSON.parse(input));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const instance = createServer({
  ...(test.tailscaleOwner !== undefined && { tailscaleOwner: test.tailscaleOwner }),
  ...(test.machines !== undefined && { machines: test.machines }),
  ...(test.acceptLoopbackPush && { pushEndpoint: loopbackPush }),
  ...(test.alertTiming && { alertTiming: test.alertTiming }),
  ...(test.submitDeadlineMs !== undefined && { submitDeadlineMs: test.submitDeadlineMs }),
  ...(test.attachRetryForMs !== undefined && { attachRetryForMs: test.attachRetryForMs }),
  ...(test.attachHeldRetryMs !== undefined && { attachHeldRetryMs: test.attachHeldRetryMs }),
  ...(test.attachRelookupForMs !== undefined && { attachRelookupForMs: test.attachRelookupForMs }),
  ...(test.terminalAttach !== undefined && { terminalAttach: test.terminalAttach }),
  // unset, createServer takes terminalAttach's value, or asks this runtime when neither is set (ADR 0122)
  ...(test.localPty !== undefined && { sidecar: test.localPty }),
});

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  instance.stop();
  // as production: attach sidecars need ~1.2s to release herdr's exclusive client slot
  setTimeout(() => process.exit(0), 2000);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log(JSON.stringify({ listening: { hostname: instance.hostname, port: instance.port } }));
