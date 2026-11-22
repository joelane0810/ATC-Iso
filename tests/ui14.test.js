import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

function luminance(hex) {
  const digits = hex.slice(1);
  const rgb = digits.length === 3 ? [...digits].map((digit) => digit.repeat(2)) : digits.match(/../g);
  const [red, green, blue] = rgb.map((pair) => {
    const channel = parseInt(pair, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

test('main UI text and background colors meet WCAG AA', async () => {
  const css = await readFile(new URL('../web/style.css', import.meta.url), 'utf8');
  const root = css.match(/:root\s*\{([^}]+)\}/)[1];
  const colors = new Map([...root.matchAll(/--([\w-]+):\s*(#[\da-f]+);/gi)]
    .map(([, name, hex]) => [name, hex]));
  const pairs = [
    ['text', 'white'], ['text', 'surface'], ['muted', 'white'], ['muted', 'surface'],
    ['white', 'accent'], ['white', 'muted'],
    ['competitor', 'white'], ['competitor', 'competitor-bg'],
    ['project', 'white'], ['project', 'project-bg'],
    ['new-text', 'new-bg'], ['accent-text', 'selected'], ['accent-text', 'white'],
    ['decrease-text', 'decrease-bg'], ['stopped-text', 'stopped-bg'], ['muted', 'steady-bg'],
    ['new-text', 'white'], ['new-text', 'surface'], ['stopped-text', 'white'], ['stopped-text', 'surface'],
    ...['competitor-bg', 'project-bg', 'new-bg', 'selected', 'decrease-bg', 'stopped-bg']
      .map((background) => ['text', background]),
  ];
  for (const [foreground, background] of pairs) {
    assert.ok(colors.has(foreground) && colors.has(background), 'Missing palette color');
    const [dark, light] = [foreground, background].map((name) => luminance(colors.get(name)))
      .sort((a, b) => a - b);
    const ratio = (light + 0.05) / (dark + 0.05);
    assert.ok(ratio >= 4.5, `${foreground} on ${background} has contrast ${ratio.toFixed(3)}:1`);
  }
});
