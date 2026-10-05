import i18n from 'i18next';
import { enUS, zhCN, zhTW, type Locale } from 'date-fns/locale';

/** Short date labels in the interface language (zh: 3月31日 / 3月 / 一; en: Mar 31 / Mar / M). */
const locale = (): string => i18n.resolvedLanguage || i18n.language || 'zh-TW';
const cache = new Map<string, Intl.DateTimeFormat>();
const formatter = (options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const key = `${locale()}|${JSON.stringify(options)}`;
  let value = cache.get(key);
  if (!value) { value = new Intl.DateTimeFormat(locale(), options); cache.set(key, value); }
  return value;
};

export const monthDayLabel = (date: Date): string => formatter({ month: 'short', day: 'numeric' }).format(date);
export const monthLabel = (date: Date): string => formatter({ month: 'short' }).format(date);
export const weekdayLabel = (date: Date): string => formatter({ weekday: 'narrow' }).format(date);

/** The date-fns locale for the interface language, for `format(..., 'EEE')` and calendars. */
export const dateFnsLocale = (language: string = locale()): Locale => {
  if (language.startsWith('zh-TW') || language === 'zh-Hant') return zhTW;
  if (language.startsWith('zh')) return zhCN;
  return enUS;
};
