/** Settings → Devices against the test server's own device store (in its temporary state folder). */
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { t } from "../src/lib/i18n.ts";

/** Pairs a device from a browser of its own, as a phone that typed the code would. */
async function pairFrom(browser: Browser, origin: string, code: string, label: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/api/health`);
    const status = await page.evaluate(async ({ code, label }) => (await fetch("/api/devices/pair", {
      method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ code, label }),
    })).status, { code, label });
    assert.equal(status, 204, `pairing ${label} with ${code}`);
  } finally {
    await context.close();
  }
}

export async function checkDevices(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await context.addInitScript(() => localStorage.setItem("herdr-fleet:settings", JSON.stringify({})));
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(origin);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const panel = page.locator(".devices-panel");
    await panel.getByText(t("No devices paired yet.")).waitFor();

    // a code, then the device it lets in shows up on its own (the panel polls while the code is out)
    await panel.getByRole("button", { name: "Pair a device", exact: true }).click();
    const codeText = panel.locator(".devices-code");
    await codeText.waitFor();
    await pairFrom(browser, origin, (await codeText.textContent())!.replace(/\s/g, ""), "First phone");
    // the first device to pair is named too, and its code is put away
    await panel.getByText(t("Paired: {name}.", { name: "First phone" })).waitFor({ timeout: 8000 });
    assert.equal(await codeText.count(), 0, "the code goes once its device paired");
    await panel.getByText("First phone", { exact: true }).waitFor();

    // so is the next one
    await panel.getByRole("button", { name: "Pair a device", exact: true }).click();
    await codeText.waitFor();
    await pairFrom(browser, origin, (await codeText.textContent())!.replace(/\s/g, ""), "Second phone");
    await panel.getByText(t("Paired: {name}.", { name: "Second phone" })).waitFor({ timeout: 8000 });
    assert.equal(await codeText.count(), 0, "the code goes once its device paired");

    // a rename keeps the name being typed until saved
    await panel.getByRole("button", { name: "Rename Second phone", exact: true }).click();
    await panel.getByRole("textbox", { name: "Device name", exact: true }).fill("Tablet");
    await panel.getByRole("button", { name: "Save name", exact: true }).click();
    await panel.getByText("Tablet", { exact: true }).waitFor();

    // revoking asks in a confirm: a no keeps the device and leaves Settings open, a yes revokes it
    const firstRow = panel.locator(".devices-row", { hasText: "First phone" });
    const confirm = page.getByRole("alertdialog");
    await firstRow.getByRole("button", { name: "Revoke", exact: true }).click();
    await confirm.getByText("Revoke First phone?", { exact: true }).waitFor();
    await confirm.getByText(t("This device stops getting in, and gets in again only with a new pairing."), { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await confirm.waitFor({ state: "detached" });
    assert.equal(await panel.isVisible(), true, "a no keeps Settings open");
    assert.equal(await firstRow.count(), 1, "a no keeps the device");
    await firstRow.getByRole("button", { name: "Revoke", exact: true }).click();
    await confirm.getByRole("button", { name: "Revoke", exact: true }).click();
    await panel.getByText("First phone", { exact: true }).waitFor({ state: "detached" });

    // the list is read again each time Settings opens
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await panel.getByText("Tablet", { exact: true }).waitFor();
    console.log("PASS Settings devices: pair (the first device named too), the next one named, rename, revoke after a confirm, read on open");
  } finally {
    await context.close();
  }
}
