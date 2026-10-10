import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nextOption, Segmented } from "./Segmented.tsx";

describe("segmented control", () => {
  it("moves among its options with the arrow keys, wrapping, and jumps with Home and End", () => {
    expect(nextOption("ArrowRight", 0, 3)).toBe(1);
    expect(nextOption("ArrowRight", 2, 3)).toBe(0);
    expect(nextOption("ArrowLeft", 0, 3)).toBe(2);
    expect(nextOption("ArrowDown", 1, 3)).toBe(2);
    expect(nextOption("ArrowUp", 1, 3)).toBe(0);
    expect(nextOption("Home", 2, 3)).toBe(0);
    expect(nextOption("End", 0, 3)).toBe(2);
    // focus outside the options starts from the first
    expect(nextOption("ArrowRight", -1, 3)).toBe(1);
  });

  it("leaves other keys alone", () => {
    expect(nextOption("Enter", 0, 3)).toBeNull();
    expect(nextOption("Tab", 0, 3)).toBeNull();
    expect(nextOption("ArrowRight", 0, 0)).toBeNull();
  });

  it("is a named group", () => {
    const html = renderToStaticMarkup(createElement(Segmented, { label: "Theme", className: "theme", children: createElement("button", { type: "button" }, "Dark") }));
    expect(html).toBe('<div class="segmented theme" role="group" aria-label="Theme"><button type="button">Dark</button></div>');
  });
});
