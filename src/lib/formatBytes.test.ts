import { describe, expect, it } from "bun:test";

import { formatBytes } from "./formatBytes.ts";

const MB = 1024 * 1024;

describe("formatBytes", () => {
  it("uses the largest unit that fits, rounded", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(179)).toBe("179 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(256 * 1024)).toBe("256 KB");
    expect(formatBytes(MB)).toBe("1 MB");
    expect(formatBytes(130 * MB)).toBe("130 MB");
  });
});
