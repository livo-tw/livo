import i18n from '@/i18n';

export type ThemeKey = 'dark' | 'blue' | 'white' | 'beige' | 'green';

export interface ThemeOption {
  key: ThemeKey;
  label: string;
  sidebarColor: string;   // preview color for sidebar
  accentColor: string;     // preview color for accent/primary
}

export function getThemes(): ThemeOption[] {
  return [
    { key: 'dark',  label: i18n.t('theme.dark'),  sidebarColor: '#1a1e2b', accentColor: '#3b82f6' },
    { key: 'blue',  label: i18n.t('theme.blue'),  sidebarColor: '#1e2d4d', accentColor: '#2563eb' },
    { key: 'white', label: i18n.t('theme.white'), sidebarColor: '#ffffff', accentColor: '#3b82f6' },
    { key: 'beige', label: i18n.t('theme.beige'), sidebarColor: '#f2ebd2', accentColor: '#c59008' },
    { key: 'green', label: i18n.t('theme.green'), sidebarColor: '#102b1d', accentColor: '#0ea55e' },
  ];
}

export function applyTheme(theme: ThemeKey) {
  document.documentElement.setAttribute('data-theme', theme);
}
