import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
const origin = process.env.ORIGIN ?? "http://127.0.0.1:7399";
const out = process.env.OUT ?? "/tmp/shots2";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const settings = JSON.stringify({ language: "en", theme: "dark" });
// desktop: hover a row, open its menu, open the confirm (then cancel), and a header menu if any
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  await ctx.addInitScript((s) => localStorage.setItem("herdr-web-ui:settings", s), settings);
  const page = await ctx.newPage();
  await page.goto(origin);
  await page.locator(".conn-live").waitFor({ timeout: 20000 }).catch(() => console.log("no conn-live"));
  await page.waitForTimeout(800);
  const rows = page.locator(".pane-item");
  console.log("rows:", await rows.count(), "headers:", await page.locator(".workspace-header").count());
  const last = rows.last();
  await last.hover();
  await page.screenshot({ path: `${out}/desktop-hover.png` });
  await last.locator(".row-menu-toggle").click();
  await page.getByRole("menu").waitFor();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/desktop-menu.png` });
  console.log("menu items:", await page.getByRole("menuitem").allTextContents());
  console.log("focused after open:", await page.evaluate(() => document.activeElement?.textContent));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "detached" });
  console.log("focus after escape is toggle:", await page.evaluate(() => document.activeElement?.classList.contains("row-menu-toggle")));
  // confirm dialog on a lone row (if the last row is merged), else just report
  const lone = await last.locator(".pane-row > .sidebar-drag-handle").count() === 1;
  console.log("last row lone:", lone);
  if (lone) {
    await last.locator(".row-menu-toggle").click();
    await page.getByRole("menuitem", { name: "Close", exact: true }).click();
    await page.getByRole("alertdialog").waitFor();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${out}/desktop-confirm.png` });
    console.log("confirm focus:", await page.evaluate(() => document.activeElement?.textContent));
    await page.keyboard.press("Escape");
    await page.getByRole("alertdialog").waitFor({ state: "detached" });
  }
  const header = page.locator(".workspace-header").first();
  if (await header.count()) {
    await header.hover();
    await header.locator(".workspace-menu").click();
    await page.getByRole("menu").waitFor();
    await page.screenshot({ path: `${out}/desktop-header-menu.png` });
    console.log("header menu items:", await page.getByRole("menuitem").allTextContents());
    await page.keyboard.press("Escape");
  }
  // rename workspace on a lone row shows an input in the row
  if (lone) {
    await last.locator(".row-menu-toggle").click();
    await page.getByRole("menuitem", { name: "Rename workspace", exact: true }).click();
    await page.locator(".workspace-rename-input").waitFor();
    console.log("rename input focused:", await page.evaluate(() => document.activeElement?.classList.contains("workspace-rename-input")));
    await page.screenshot({ path: `${out}/desktop-rename-workspace.png` });
    await page.keyboard.press("Escape");
  }
  await ctx.close();
}
// phone: drawer, sheet, confirm
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript((s) => localStorage.setItem("herdr-web-ui:settings", s), settings);
  const page = await ctx.newPage();
  await page.goto(origin);
  await page.locator(".conn-live").waitFor({ timeout: 20000 }).catch(() => console.log("no conn-live"));
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/phone-drawer.png` });
  const last = page.locator(".pane-item").last();
  await last.locator(".row-menu-toggle").click();
  await page.locator(".row-sheet").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/phone-sheet.png` });
  const lone = await last.locator(".pane-row > .sidebar-drag-handle").count() === 1;
  if (lone) {
    await page.locator(".row-sheet-item", { hasText: "Close" }).click();
    await page.getByRole("alertdialog").waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/phone-confirm.png` });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  } else {
    await page.locator(".row-sheet-cancel").click();
  }
  console.log("phone overflow:", await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  await ctx.close();
}
await browser.close();
console.log("done", out);
