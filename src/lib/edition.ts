// Open-source edition metadata (AGPL-3.0).
//
// LIVO is published under the GNU AGPL v3. Section 13 of that license asks
// anyone who runs a modified copy as a network service to offer its users the
// corresponding source. The system-admin page and the demo banner link to
// SOURCE_URL for that reason. A fork that deploys changed code should set
// VITE_SOURCE_URL to its own repository.

import i18n from '@/i18n';

export const SOURCE_URL: string = import.meta.env.VITE_SOURCE_URL || 'https://github.com/livo-tw/livo';

export type EditionLang = 'zh-TW' | 'zh-CN' | 'en';

/** The UI language, collapsed to the three locales LIVO ships. */
export function editionLang(): EditionLang {
  const lang = (i18n.language || '').toLowerCase();
  if (lang.startsWith('zh')) {
    return lang.includes('cn') || lang.includes('hans') || lang.includes('sg') ? 'zh-CN' : 'zh-TW';
  }
  return 'en';
}

/** Pick the string for the current UI language. */
export function editionText(texts: Record<EditionLang, string>): string {
  return texts[editionLang()];
}

export const LICENSE_NOT_REQUIRED: Record<EditionLang, string> = {
  'zh-TW': '開源版不需要授權金鑰，所有功能都已開放。',
  'zh-CN': '开源版不需要授权密钥，所有功能都已开放。',
  en: 'The open-source edition needs no license key. Every feature is available.',
};
