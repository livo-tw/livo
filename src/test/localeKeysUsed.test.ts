import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import en from '@/i18n/locales/en.json';
import zhTW from '@/i18n/locales/zh-TW.json';
import zhCN from '@/i18n/locales/zh-CN.json';

const ROOT = path.resolve(__dirname, '..');
const LOCALES: Record<string, unknown> = { en, 'zh-TW': zhTW, 'zh-CN': zhCN };
const lookup = (tree: unknown, key: string): unknown => key.split('.').reduce<unknown>((node, part) =>
  node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined, tree);
const translated = (tree: unknown, key: string) => ['', '_one', '_other'].some(suffix => typeof lookup(tree, key + suffix) === 'string');
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}
/** Literal `t('a.b')` keys only; dynamic keys are covered by their own tests. */
function literalKeys(files: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)'/g)) {
      if (!found.has(match[1])) found.set(match[1], path.relative(ROOT, file));
    }
  }
  return found;
}

describe('every literal translation key used anywhere in the app exists', () => {
  const files = sources(ROOT);
  const used = literalKeys(files);
  it.each(Object.keys(LOCALES))('%s has every key', language => {
    expect(used.size).toBeGreaterThan(2000);
    const missing = [...used].filter(([key]) => !translated(LOCALES[language], key)).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });
});

describe('every literal translation key used by the knowledge and QA screens exists', () => {
  const files = [...sources(path.join(ROOT, 'components/knowledge')), ...sources(path.join(ROOT, 'components/knowledge-work')),
    ...sources(path.join(ROOT, 'components/qa')), path.join(ROOT, 'components/KnowledgeBaseView.tsx')];
  const used = literalKeys(files);
  it.each(Object.keys(LOCALES))('%s has every key', language => {
    expect(used.size).toBeGreaterThan(50);
    const missing = [...used].filter(([key]) => !translated(LOCALES[language], key)).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });
  it('includes the close, reload and retry actions that were shown as raw keys', () => {
    for (const key of ['kb.close', 'qa.reload', 'qa.retry']) expect(used.has(key), key).toBe(true);
  });
  it('uses traditional characters in the traditional Chinese processor message', () => {
    expect(lookup(zhTW, 'kbImport.processor_not_configured')).toBe('尚未設定私有文件處理服務。');
  });
  it('explains refused page deletion and private-draft moves in every language', () => {
    for (const tree of Object.values(LOCALES)) for (const key of ['kb.errors.kb_delete_blocked', 'kb.errors.kb_private_draft_parent']) expect(translated(tree, key), key).toBe(true);
  });
});
