import { useEffect, useState } from 'react';
import { applyTheme, saveTheme, storedTheme } from '../utils/theme';

/** The theme choice ('light' | 'dark' | 'system') and a setter that saves and applies it. */
export function useTheme() {
  const [theme, setThemeState] = useState(storedTheme);

  // "Device" follows the device setting while the page is open.
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system' || !window.matchMedia) return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme('system');
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, [theme]);

  const setTheme = (choice) => {
    saveTheme(choice);
    setThemeState(choice);
  };
  return [theme, setTheme];
}
