import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";

export async function assertLoadedChatAvatar(container: Locator, userId: number) {
  const avatar = container.locator('[data-chat-avatar="image"]').first();
  await avatar.waitFor({ state: "visible" });
  const image = avatar.locator("img");
  const width = await image.evaluate(async node => {
    if (!(node instanceof HTMLImageElement)) throw new Error("Expected an image element");
    await node.decode();
    return node.naturalWidth;
  });
  assert(width > 0, "A real uploaded image must decode successfully");
  assert.match(await image.getAttribute("src") ?? "", new RegExp(`^/api/chat/avatars/${userId}\\?`));
  assert.equal(await image.getAttribute("alt"), "");
  assert.equal(await image.getAttribute("referrerpolicy"), "no-referrer");
}

export async function assertChatAvatarFallback(container: Locator) {
  const avatar = container.locator('[data-chat-avatar="fallback"]').first();
  await avatar.waitFor({ state: "visible" });
  assert.equal(await avatar.locator("img").count(), 0, "Missing or failed photos show the fallback without a broken image");
  assert((await avatar.textContent())?.trim() || await avatar.locator("svg").count() > 0);
}

/** Real picker actions verify UTF-16 limits, selection replacement and focus. */
export async function composeChatEmoji(page: Page, label: string, base: string, checkLimit = true, screenshotPath?: string) {
  const composer = page.getByRole("textbox", { name: label, exact: true });
  const trigger = page.getByRole("button", { name: "اختيار رمز تعبيري", exact: true });
  const picker = page.getByRole("dialog", { name: "الرموز التعبيرية", exact: true });
  const selectRange = async (start: number, end = start) => composer.evaluate((node, range) => {
    if (!(node instanceof HTMLTextAreaElement)) throw new Error("Expected the chat composer");
    node.focus(); node.setSelectionRange(range.start, range.end);
  }, { start, end });
  if (checkLimit) {
    await composer.fill("x".repeat(3999)); await selectRange(3999);
    await trigger.click(); await picker.getByRole("button", { name: "ابتسامة", exact: true }).click();
    await picker.getByText(/لا توجد مساحة كافية/).waitFor();
    assert.equal((await composer.inputValue()).length, 3999, "A two-code-unit emoji must not exceed the message limit");
    await page.keyboard.press("Escape"); await picker.waitFor({ state: "hidden" });
    await selectRange(3998, 3999);
    await trigger.click(); await picker.getByRole("button", { name: "ابتسامة", exact: true }).click();
    const bounded = await composer.inputValue(); assert.equal(bounded.length, 4000); assert(bounded.endsWith("😊"));
  }
  const initial = `${base} OLD النهاية`, expected = `${base} 😊 النهاية`;
  const start = base.length + 1, caret = start + "😊".length;
  await composer.fill(initial); await selectRange(start, start + 3);
  await trigger.click(); await picker.getByRole("button", { name: "ابتسامة", exact: true }).click();
  assert.equal(await composer.inputValue(), expected, "The picker replaces the selected text at the remembered caret");
  await page.waitForFunction(({ label, caret }) => {
    const node = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
    return !!node && document.activeElement === node && node.selectionStart === caret && node.selectionEnd === caret;
  }, { label, caret });
  await trigger.click(); await picker.waitFor({ state: "visible" });
  const bounds = await picker.boundingBox(), viewport = page.viewportSize()!;
  assert(bounds && bounds.width > 0 && bounds.height > 0 && bounds.x >= -1 && bounds.y >= -1 &&
    bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1,
  "The open emoji picker must fit inside the desktop or mobile viewport in RTL");
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "اختيار رمز تعبيري");
  return expected;
}
