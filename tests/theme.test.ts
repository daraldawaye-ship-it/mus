import assert from "node:assert/strict";
import test from "node:test";
import { buildThemeTokens, contrastRatio } from "../apps/web/src/theme.tsx";

// An independent WCAG calculation prevents a palette and its own checker sharing a defect.
function wcagRatio(a: string, b: string): number {
  function lightness(hex: string): number {
    const components = hex
      .slice(1)
      .match(/../g)!
      .map((value) => Number.parseInt(value, 16) / 255);
    return components
      .map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      )
      .reduce(
        (total, value, index) =>
          total + value * [0.2126, 0.7152, 0.0722][index]!,
        0,
      );
  }
  const first = lightness(a),
    second = lightness(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("contrast calculations match known WCAG ratios", () => {
  assert.equal(contrastRatio("#ffffff", "#000000"), 21);
  assert.equal(contrastRatio("#123456", "#123456"), 1);
  assert(
    Math.abs(contrastRatio("#777777", "#ffffff") - 4.478089453577214) < 1e-10,
  );
  assert.equal(
    contrastRatio("#abcdef", "#123456"),
    contrastRatio("#123456", "#abcdef"),
  );
});

test("actual theme surfaces retain readable text for arbitrary light and dark colors", () => {
  const pairs = [
    ["--text", "--bg"],
    ["--text", "--surface"],
    ["--muted", "--surface"],
    ["--on-primary", "--primary"],
    ["--primary", "--surface"],
    ["--on-soft", "--soft"],
    ["--text", "--table-head"],
    ["--text", "--nav"],
    ["--on-nav-active", "--nav-active"],
    ["--on-table-selected", "--table-selected"],
    ["--text", "--hover"],
    ...["success", "warning", "error", "info"].flatMap((tone) => [
      [`--${tone}-text`, `--${tone}-bg`],
      [`--on-${tone}`, `--${tone}-solid`],
    ]),
  ];
  const colors = [
    "#000000",
    "#ffffff",
    "#ffff00",
    "#00ffff",
    "#ff00ff",
    "#777777",
    "#818181",
    "#ff0000",
    "#176b61",
    "#123456",
    "#abcdef",
  ];
  for (const mode of ["light", "dark"] as const)
    for (const color of colors) {
      const tokens = buildThemeTokens(mode, color);
      for (const [foreground, background] of pairs) {
        assert.match(
          tokens[foreground]!,
          /^#[0-9a-f]{6}$/i,
          `${mode} ${color} ${foreground}`,
        );
        assert.match(
          tokens[background]!,
          /^#[0-9a-f]{6}$/i,
          `${mode} ${color} ${background}`,
        );
        const ratio = wcagRatio(tokens[foreground]!, tokens[background]!);
        assert(
          ratio >= 4.5,
          `${mode} ${color} ${foreground}/${background} contrast ${ratio.toFixed(3)} < 4.5`,
        );
      }
    }
});

test("invalid color input uses the documented safe fallback palette", () => {
  for (const mode of ["light", "dark"] as const) {
    assert.deepEqual(
      buildThemeTokens(mode, "red"),
      buildThemeTokens(mode, "#176b61"),
    );
    assert.deepEqual(
      buildThemeTokens(mode, "#fff"),
      buildThemeTokens(mode, "#176b61"),
    );
  }
});
