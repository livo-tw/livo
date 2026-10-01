// Attachment files inside a Jira Cloud site backup — the zip itself or the
// folder it was unpacked to. Files live at
//   data/attachments/<project key>/<bucket>/<issue key>/<attachment id>
// named by attachment id, without an extension. A project whose key was
// changed keeps its files under the OLD key, so files are indexed by id
// across the whole attachments tree, never located from the issue key.

import fs from 'node:fs/promises';
import path from 'node:path';
import { openZip } from './zip-reader.mjs';

/** True for ".../attachments/.../<digits>" — thumbnails ("_thumb_…") and folders are skipped. */
export function attachmentIdFromPath(p) {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  const i = parts.lastIndexOf('attachments');
  if (i < 0 || i >= parts.length - 1) return null;
  const base = parts[parts.length - 1];
  return /^\d+$/.test(base) ? base : null;
}

async function walk(dir, out) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

/**
 * @returns {Promise<{ files: Map<string, { path: string, size: number, read: () => Promise<Buffer> }>,
 *                     duplicates: string[], close: () => Promise<void> }>}
 */
export async function openBackup(source) {
  const stat = await fs.stat(source);
  const files = new Map();
  const duplicates = [];
  const add = (id, file) => {
    if (files.has(id)) duplicates.push(id);
    else files.set(id, file);
  };

  if (stat.isDirectory()) {
    const all = [];
    await walk(source, all);
    for (const full of all) {
      const id = attachmentIdFromPath(path.relative(source, full));
      if (!id) continue;
      const { size } = await fs.stat(full);
      add(id, { path: full, size, read: () => fs.readFile(full) });
    }
    return { files, duplicates, close: async () => {} };
  }

  const zip = await openZip(source);
  for (const entry of zip.entries) {
    if (entry.directory) continue;
    const id = attachmentIdFromPath(entry.name);
    if (id) add(id, { path: entry.name, size: entry.size, read: () => zip.read(entry) });
  }
  return { files, duplicates, close: () => zip.close() };
}
