import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import zhTW from '@/i18n/locales/zh-TW.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import en from '@/i18n/locales/en.json';
import { knowledgeImportMessages } from '@/i18n/knowledgeImport';

const workerDir = join(process.cwd(), 'worker', 'src');
const codes = new Set<string>();
for (const name of readdirSync(workerDir).filter(file => file.startsWith('knowledgeImport') && file.endsWith('.ts'))) {
  const source = readFileSync(join(workerDir, name), 'utf8');
  for (const match of source.matchAll(/ImportError\('([a-z_]+)'/g)) codes.add(match[1]);
  for (const match of source.matchAll(/warnings\.push\('([a-z_]+)'\)/g)) codes.add(match[1]);
}

describe('knowledge import messages', () => {
  it('explain every error and warning the server can return, in every language', () => {
    expect(codes.size).toBeGreaterThan(30);
    const missing: string[] = [];
    for (const code of codes) for (const [language, locale] of [['zh-TW', zhTW], ['zh-CN', zhCN], ['en', en]] as const) {
      const fromLocale = (locale as { kbImport?: Record<string, unknown> }).kbImport?.[code];
      const builtIn = (knowledgeImportMessages as Record<string, Record<string, string>>)[language]?.[code];
      if (typeof fromLocale !== 'string' && typeof builtIn !== 'string') missing.push(`${language}:${code}`);
    }
    expect(missing).toEqual([]);
  });
});
