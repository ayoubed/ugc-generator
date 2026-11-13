/**
 * Light and dark theme, switched with the toggle in the header. The choice is kept in this
 * browser. ("system", following the device setting, is still understood but no longer offered.)
 * The theme is applied by setting data-theme on <html>, which swaps the colour variables in
 * index.css. index.html applies the saved choice before the app loads, so there is no flash.
 */
export const THEME_KEY = 'eleviat-theme';
const CHOICES = ['light', 'dark', 'system'];
const DEFAULT_THEME = 'light';

/** The saved choice: 'light', 'dark' or 'system'. */
export function storedTheme() {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return CHOICES.includes(saved) ? saved : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME; // storage blocked (private window)
  }
}

/** What a choice means right now: 'light' or 'dark'. */
export function resolveTheme(choice) {
  if (choice === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return choice === 'dark' ? 'dark' : 'light';
}

export function applyTheme(choice) {
  document.documentElement.dataset.theme = resolveTheme(choice);
}

/** Saves the choice and applies it. */
export function saveTheme(choice) {
  try {
    window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // the choice then lasts until the page is reloaded
  }
  applyTheme(choice);
}
