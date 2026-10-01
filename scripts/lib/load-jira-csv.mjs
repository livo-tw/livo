// Loads worker/src/functions/jiraCsv.ts (the single source of the Jira header
// aliases and parsing) from plain Node: transpiled with the repo's own
// `typescript` dev dependency, or imported directly on a Node with built-in
// type stripping.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../worker/src/functions/jiraCsv.ts');

export async function loadJiraCsv() {
  let ts = null;
  try {
    ts = (await import('typescript')).default;
  } catch {
    ts = null;
  }
  if (ts) {
    const js = ts.transpileModule(fs.readFileSync(SOURCE, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  }
  try {
    return await import(pathToFileURL(SOURCE).href);
  } catch (err) {
    throw new Error(`無法載入 ${SOURCE}：請先在 LIVO-local-ready 執行 npm install（需要 typescript）。(${err.message})`);
  }
}
