export type AppAppearanceMode = 'system' | 'light' | 'dark';
export type AppThemeName = 'modern' | 'classic' | 'brutalist' | 'glassmorphism' | 'playful' | 'lineageos24';

export const LINEAGEOS24_PALETTES = {
  light: {
    primary: '#6750A4', onPrimary: '#FFFFFF', secondary: '#625B71', tertiary: '#7D5260',
    surface: '#F7F2FA', surfaceContainer: '#F0ECF4', surfaceContainerHigh: '#EAE6EE',
    onSurface: '#1D1B20', onSurfaceVariant: '#49454F', outline: '#79747E',
    outlineVariant: '#CAC4D0', error: '#B3261E', success: '#386A20', sidebar: '#F0ECF4',
  },
  dark: {
    primary: '#D0BCFF', onPrimary: '#381E72', secondary: '#CCC2DC', tertiary: '#EFB8C8',
    surface: '#141218', surfaceContainer: '#211F26', surfaceContainerHigh: '#2B2930',
    onSurface: '#E6E0E9', onSurfaceVariant: '#CAC4D0', outline: '#938F99',
    outlineVariant: '#49454F', error: '#F2B8B5', success: '#A8D5A2', sidebar: '#211F26',
  },
} as const;

export function getLineagePalette(mode: 'light' | 'dark') {
  return LINEAGEOS24_PALETTES[mode];
}

export function resolveAppearanceMode(mode: string, prefersDark: boolean): 'light' | 'dark' {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}

function applyLineagePalette(mode: 'light' | 'dark') {
  const root = document.documentElement;
  const palette = getLineagePalette(mode);
  const tokens: Record<string, string> = {
    '--md-primary': palette.primary,
    '--md-on-primary': palette.onPrimary,
    '--md-secondary': palette.secondary,
    '--md-tertiary': palette.tertiary,
    '--md-surface': palette.surface,
    '--md-surface-container': palette.surfaceContainer,
    '--md-surface-container-high': palette.surfaceContainerHigh,
    '--md-on-surface': palette.onSurface,
    '--md-on-surface-variant': palette.onSurfaceVariant,
    '--md-outline': palette.outline,
    '--md-outline-variant': palette.outlineVariant,
    '--md-error': palette.error,
    '--md-success': palette.success,
    '--primary-color': palette.primary,
    '--secondary-color': palette.secondary,
    '--sidebar-bg': palette.sidebar,
    '--header-bg': palette.surfaceContainer,
    '--app-bg': palette.surface,
    '--text-main': palette.onSurface,
    '--border-radius': '1.25rem',
    '--shadow-sm': '0 1px 3px rgb(0 0 0 / 0.12), 0 1px 2px rgb(0 0 0 / 0.08)',
  };
  Object.entries(tokens).forEach(([key, value]) => root.style.setProperty(key, value));
  root.dataset.colorMode = mode;
  document.body.style.colorScheme = mode;
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
  root.dataset.colorPreference = ['light', 'dark', 'system'].includes(appearanceMode) ? appearanceMode : 'system';

  if (themeName === 'lineageos24') {
    const prefersDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyLineagePalette(resolveAppearanceMode(appearanceMode, prefersDark));
  } else {
    root.dataset.colorMode = appearanceMode;
    body.style.colorScheme = appearanceMode === 'system' ? 'normal' : appearanceMode;
  }
}

export function watchSystemAppearance(settings: Record<string, unknown> = {}) {
  if (typeof window === 'undefined' || String(settings.themeName || '') !== 'lineageos24' ||
      String(settings.appearanceMode || 'system') !== 'system') return () => {};
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const update = () => applyAppTheme(settings);
  media.addEventListener?.('change', update);
  return () => media.removeEventListener?.('change', update);
}
