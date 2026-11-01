// Color themes. A theme is only a data-theme value on <html>; app.css holds the tokens.
// Six choices: each theme in light and dark. Until one is picked (nothing saved, or junk saved)
// no data-theme is set and the page follows the system's dark mode with Sage.
export const THEMES = [
  { id: 'sage', name: 'Sage light', swatch: ['#F0F0E6', '#4A3E7A', '#4C6838'] },
  { id: 'sage-dark', name: 'Sage dark', swatch: ['#1A1B17', '#B4A8EA', '#93B879'] },
  { id: 'parchment', name: 'Parchment light', swatch: ['#F5F0E6', '#1E5B60', '#8A5A12'] },
  { id: 'parchment-dark', name: 'Parchment dark', swatch: ['#1B1916', '#73C2BF', '#CE9638'] },
  { id: 'linen', name: 'Linen light', swatch: ['#F2EFE8', '#24427A', '#9A4422'] },
  { id: 'linen-dark', name: 'Linen dark', swatch: ['#171A20', '#93B3EC', '#DD8A62'] },
];
export const DEFAULT_THEME = null; // null = no choice yet: follow the system
const KEY = 'vm-theme';

// A known id passes through (old saves 'sage', 'parchment', 'linen' are the light themes); anything else is null.
export function resolveTheme(value) {
  return THEMES.some((t) => t.id === value) ? value : DEFAULT_THEME;
}

export function loadTheme(storage) {
  try { return resolveTheme(storage.getItem(KEY)); } catch { return DEFAULT_THEME; }
}

export function saveTheme(storage, id) {
  const v = resolveTheme(id);
  if (v === null) return;
  try { storage.setItem(KEY, v); } catch { /* storage unavailable: the theme just won't persist */ }
}

// The theme currently showing: the choice, or sage / sage-dark per the system.
export function shownTheme(choice, systemDark) {
  return choice ?? (systemDark ? 'sage-dark' : 'sage');
}
