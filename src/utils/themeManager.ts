export type AppAppearanceMode = 'system' | 'light' | 'dark';
export type AppThemeName = 'modern' | 'classic' | 'brutalist' | 'glassmorphism' | 'playful' | 'lineageos24';

export const LINEAGEOS24_PALETTES = {
  light: {
    primary: '#6750A4',
    onPrimary: '#FFFFFF',
    secondary: '#625B71',
    tertiary: '#7D5260',
    surface: '#F7F2FA',
    surfaceContainer: '#F0ECF4',
    surfaceContainerHigh: '#EAE6EE',
    onSurface: '#1D1B20',
    onSurfaceVariant: '#49454F',
    outline: '#79747E',
    outlineVariant: '#CAC4D0',
    error: '#B3261E',
    success: '#386A20',
    sidebar: '#F0ECF4',
  },
  dark: {
    primary: '#D0BCFF',
    onPrimary: '#381E72',
    secondary: '#CCC2DC',
    tertiary: '#EFB8C8',
    surface: '#141218',
    surfaceContainer: '#211F26',
    surfaceContainerHigh: '#2B2930',
    onSurface: '#E6E0E9',
    onSurfaceVariant: '#CAC4D0',
    outline: '#938F99',
    outlineVariant: '#49454F',
    error: '#F2B8B5',
    success: '#A8D5A2',
    sidebar: '#211F26',
  },
} as const;

export function getLineagePalette(mode: 'light' | 'dark') {
  return LINEAGEOS24_PALETTES[mode];
}

export function applyAppTheme(settings: Record<string, unknown> = {}) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const body = document.body;
  const themeName = String(settings.themeName || 'modern');
  const appearanceMode = String(settings.appearanceMode || 'system');
  body.classList.forEach((name) => {
    if (name.startsWith('theme-')) body.classList.remove(name);
  });
  body.classList.add(`theme-${themeName}`);
  root.dataset.appTheme = themeName;
  root.dataset.colorMode = ['light', 'dark', 'system'].includes(appearanceMode) ? appearanceMode : 'system';

  if (themeName === 'lineageos24') {
    const mode = appearanceMode === 'dark' ? 'dark' : 'light';
    const palette = getLineagePalette(mode);
    root.style.setProperty('--primary-color', palette.primary);
    root.style.setProperty('--secondary-color', palette.secondary);
    root.style.setProperty('--sidebar-bg', palette.sidebar);
    root.style.setProperty('--header-bg', palette.surfaceContainer);
    root.style.setProperty('--app-bg', palette.surface);
    root.style.setProperty('--text-main', palette.onSurface);
    root.style.setProperty('--border-radius', '1.25rem');
    root.style.setProperty('--shadow-sm', '0 1px 3px rgb(0 0 0 / 0.12), 0 1px 2px rgb(0 0 0 / 0.08)');
  }
}
