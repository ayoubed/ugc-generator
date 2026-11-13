import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THEME_KEY, applyTheme, resolveTheme, saveTheme, storedTheme } from './theme';

const deviceIsDark = (dark) => {
  window.matchMedia = (query) => ({ matches: dark && query === '(prefers-color-scheme: dark)', addEventListener() {}, removeEventListener() {} });
};

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  delete window.matchMedia;
});

describe('theme choice', () => {
  it('is light until something else is chosen', () => {
    expect(storedTheme()).toBe('light');
    window.localStorage.setItem(THEME_KEY, 'sepia');
    expect(storedTheme()).toBe('light');
  });

  it('is saved in this browser and applied to the page', () => {
    saveTheme('dark');
    expect(storedTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    saveTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows the device when asked to', () => {
    deviceIsDark(true);
    expect(resolveTheme('system')).toBe('dark');
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
    deviceIsDark(false);
    expect(resolveTheme('system')).toBe('light');
  });

  it('falls back to light on a device that cannot say', () => {
    expect(resolveTheme('system')).toBe('light');
    expect(resolveTheme('anything')).toBe('light');
  });
});

// The stylesheet and components, read as text: both themes only work while every colour goes
// through a variable. These tests fail when a new hard-coded colour is added.
const SRC = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
const block = (start) => {
  const from = css.indexOf(start);
  return css.slice(from, css.indexOf('\n}\n', from));
};
const light = block(':root {');
const dark = block(':root[data-theme="dark"] {');
const COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

describe('colours', () => {
  it('gives every colour variable a dark value', () => {
    const names = (text) => new Set([...text.matchAll(/^\s*(--(?:bg|text|color|shadow|on)-[\w-]+):/gm)].map((m) => m[1]));
    const missing = [...names(light)].filter((name) => !names(dark).has(name));
    expect(missing).toEqual([]);
  });

  it('keeps hard-coded colours out of the stylesheet, except the ones that belong to the video', () => {
    // Players, caption samples and overlays on footage look the same in both themes.
    const allowed = new Set([
      '#000', '#fff', '#ffffff', '#0f172a', '#1e1b4b', '#14181d', '#ffe600', '#fecaca', '#b45309',
      'rgba(255, 255, 255, 0.3)', 'rgba(255, 255, 255, 0.22)', 'rgba(255, 255, 255, 0.12)',
      'rgba(15, 23, 42, 0.72)', 'rgba(15, 23, 42, 0.2)', 'rgba(0, 0, 0, 0.53)',
      'rgba(129, 140, 248, 0.22)', 'rgba(129, 140, 248, 0)',
    ]);
    const rest = css.replace(light, '').replace(dark, '');
    const found = new Set((rest.match(COLOUR) || []).map((c) => c.toLowerCase()));
    expect([...found].filter((c) => !allowed.has(c))).toEqual([]);
    // No more of them than today: a new one has to use a variable.
    expect((rest.match(COLOUR) || []).length).toBeLessThanOrEqual(23);
  });

  it('keeps hard-coded colours out of the components', () => {
    // The video player's own surround and the Google logo are the same in both themes.
    const exempt = ['VideoPreview.jsx', 'LoginPage.jsx'];
    const offenders = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(file);
      if (!entry.name.endsWith('.jsx') || entry.name.endsWith('.test.jsx') || exempt.includes(entry.name)) return undefined;
      if (COLOUR.test(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(SRC, file));
      COLOUR.lastIndex = 0;
      return undefined;
    });
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
