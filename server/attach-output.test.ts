import { expect, it } from "bun:test";
import { AttachStartupProbes } from "./attach-output.ts";

// the bridge's own test: setup is mode switches and cursor styles, maybe cut short (server/index.ts)
const PREAMBLE = /^(?:\x1b\[(?:\?[\d;]+[hl]|\d* q))*(?:\x1b(?:\[(?:\?[\d;]*|\d+ ?| )?)?)?$/;

/** Feeds reads as the bridge does: each sees what earlier reads already let through. */
function feed(probes: AttachStartupProbes, reads: string[]): { output: string; replies: string } {
  let output = "";
  let replies = "";
  for (const read of reads) {
    const before = output;
    const taken = probes.take(read, (text) => PREAMBLE.test(before + text));
    output += taken.output;
    replies += taken.replies;
  }
  return { output: output + probes.flush(), replies };
}

it("answers herdr's startup probes and keeps them out of the output across every read boundary", () => {
  const input = "\x1b[?1049h\x1b[?1016$p\x1b[cpane\x1b[?1049l";
  for (let cut = 1; cut < input.length; cut++) {
    expect(feed(new AttachStartupProbes(), [input.slice(0, cut), input.slice(cut)]))
      .toEqual({ output: "\x1b[?1049hpane\x1b[?1049l", replies: "\x1b[?1016;4$y\x1b[?1;2c" });
  }
});

it("leaves everything from the first real output on alone, in the same read too", () => {
  for (const input of ["pane\x1b[c", "\x1b[?1049hpane\x1b[?1016$p", "\x1b[?1004h\x1b[0c", "text\x1b[?10"]) {
    expect(feed(new AttachStartupProbes(), [input])).toEqual({ output: input, replies: "" });
  }
});

it("returns a held start that never became a probe", () => {
  const probes = new AttachStartupProbes();
  expect(probes.take("\x1b[?1049h\x1b[?10", (text) => PREAMBLE.test(text))).toEqual({ output: "\x1b[?1049h", replies: "" });
  expect(probes.flush() + probes.flush()).toBe("\x1b[?10");
});
