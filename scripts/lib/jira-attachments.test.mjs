// @vitest-environment node
// scripts/jira-attachments.mjs helpers: ZIP reading (incl. ZIP64), finding
// attachments in a Jira site backup, inline-image replacement, signing in.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openZip } from './zip-reader.mjs';
import { attachmentIdFromPath, openBackup } from './jira-backup.mjs';
import {
  contentTypeFor,
  parseSize,
  replaceInlineImages,
  reportCsv,
  storagePathFor,
} from './jira-attachments-core.mjs';
import { connectLivo } from './livo-client.mjs';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Writes a ZIP the way common tools do; zip64 forces every ZIP64 field. */
function buildZip(files, { zip64 = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.method === 8 ? zlib.deflateRawSync(f.data) : f.data;
    const crc = crc32(f.data);
    const localExtra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) {
      localExtra.writeUInt16LE(0x0001, 0);
      localExtra.writeUInt16LE(16, 2);
      localExtra.writeBigUInt64LE(BigInt(f.data.length), 4);
      localExtra.writeBigUInt64LE(BigInt(data.length), 12);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(f.method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? 0xffffffff : data.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    parts.push(local, name, localExtra, data);

    const cdExtra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      cdExtra.writeUInt16LE(0x0001, 0);
      cdExtra.writeUInt16LE(24, 2);
      cdExtra.writeBigUInt64LE(BigInt(f.data.length), 4);
      cdExtra.writeBigUInt64LE(BigInt(data.length), 12);
      cdExtra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(zip64 ? 45 : 20, 4);
    cd.writeUInt16LE(zip64 ? 45 : 20, 6);
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(f.method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20);
    cd.writeUInt32LE(zip64 ? 0xffffffff : f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(cdExtra.length, 30);
    cd.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    central.push(cd, name, cdExtra);
    offset += 30 + name.length + localExtra.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const tail = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(files.length), 24);
    rec.writeBigUInt64LE(BigInt(files.length), 32);
    rec.writeBigUInt64LE(BigInt(cdBuf.length), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + cdBuf.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : files.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : files.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cdBuf.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...parts, cdBuf, ...tail, eocd]);
}

const PNG = Buffer.from('fake png bytes '.repeat(200));
const PDF = Buffer.from('%PDF-1.4 fake');
const FILES = [
  { name: 'data/entities.xml', data: Buffer.from('<entity-engine-xml/>'), method: 8 },
  { name: 'data/attachments/OLDKEY/10000/OLDKEY-7/20001', data: PNG, method: 8 },
  { name: 'data/attachments/NOVA/10000/NOVA-2/20002', data: PDF, method: 0 },
  { name: 'data/attachments/NOVA/10000/NOVA-2/thumbs/_thumb_20001.png', data: Buffer.from('thumb'), method: 0 },
  { name: 'data/attachments/NOVA/10000/NOVA-2/', data: Buffer.alloc(0), method: 0 },
];

let dir;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'livo-jira-att-'));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('zip reader', () => {
  for (const zip64 of [false, true]) {
    it(`reads stored and deflated entries${zip64 ? ' (ZIP64)' : ''}`, async () => {
      const file = path.join(dir, zip64 ? 'z64.zip' : 'plain.zip');
      await fs.writeFile(file, buildZip(FILES, { zip64 }));
      const zip = await openZip(file);
      expect(zip.entries.map((e) => e.name)).toEqual(FILES.map((f) => f.name));
      const png = zip.entries.find((e) => e.name.endsWith('/20001'));
      expect(png.size).toBe(PNG.length);
      expect((await zip.read(png)).equals(PNG)).toBe(true);
      const pdf = zip.entries.find((e) => e.name.endsWith('/20002'));
      expect((await zip.read(pdf)).equals(PDF)).toBe(true);
      await zip.close();
    });
  }

  it('rejects files that are not ZIPs', async () => {
    const file = path.join(dir, 'not.zip');
    await fs.writeFile(file, 'hello');
    await expect(openZip(file)).rejects.toThrow(/Not a ZIP/);
  });
});

describe('Jira backup index', () => {
  it('finds attachments by id anywhere under attachments/, skipping thumbnails', () => {
    expect(attachmentIdFromPath('data/attachments/OLD/10000/OLD-1/20001')).toBe('20001');
    expect(attachmentIdFromPath('backup\\data\\attachments\\A\\1\\A-1\\30')).toBe('30');
    expect(attachmentIdFromPath('data/attachments/A/1/A-1/thumbs/_thumb_30.png')).toBeNull();
    expect(attachmentIdFromPath('data/avatars/10011')).toBeNull();
  });

  it('indexes a zip and an unpacked folder the same way', async () => {
    const zipFile = path.join(dir, 'backup.zip');
    await fs.writeFile(zipFile, buildZip(FILES));
    const folder = path.join(dir, 'unpacked');
    for (const f of FILES) {
      const target = path.join(folder, f.name);
      if (f.name.endsWith('/')) await fs.mkdir(target, { recursive: true });
      else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, f.data);
      }
    }
    for (const source of [zipFile, folder]) {
      const backup = await openBackup(source);
      expect(Array.from(backup.files.keys()).sort()).toEqual(['20001', '20002']);
      const png = backup.files.get('20001');
      expect(png.size).toBe(PNG.length);
      expect((await png.read()).equals(PNG)).toBe(true);
      await backup.close();
    }
  });
});

describe('inline images', () => {
  const urls = new Map([
    ['form-error.png', 'https://api.example/api/storage/task-images/NOVA-2/1_a.png'],
    ['spec & notes.pdf', 'https://api.example/api/storage/task-images/NOVA-2/2_b.pdf'],
  ]);

  it('replaces the import markers and raw Jira markup of this task only', () => {
    const html = '<p>[圖片: form-error.png]</p><p>!form-error.png|width=400!</p><p>[圖片: other.png]</p><p>!spec &amp; notes.pdf!</p><p>Wow! Nice!</p>';
    const { html: out, replaced } = replaceInlineImages(html, urls);
    expect(replaced).toBe(3);
    expect(out).toBe(
      '<p><img src="https://api.example/api/storage/task-images/NOVA-2/1_a.png" alt="form-error.png"></p>' +
      '<p><img src="https://api.example/api/storage/task-images/NOVA-2/1_a.png" alt="form-error.png"></p>' +
      '<p>[圖片: other.png]</p>' +
      '<p><a href="https://api.example/api/storage/task-images/NOVA-2/2_b.pdf">spec &amp; notes.pdf</a></p>' +
      '<p>Wow! Nice!</p>'
    );
  });

  it('leaves text without references alone', () => {
    expect(replaceInlineImages('<p>no images</p>', urls)).toEqual({ html: '<p>no images</p>', replaced: 0 });
  });
});

describe('small helpers', () => {
  it('parses sizes', () => {
    expect(parseSize('50')).toBe(50 * 1024 * 1024);
    expect(parseSize('20MB')).toBe(20 * 1024 * 1024);
    expect(parseSize('1.5 GiB')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseSize('512k')).toBe(512 * 1024);
    expect(parseSize('')).toBeNull();
    expect(Number.isNaN(parseSize('lots'))).toBe(true);
  });

  it('builds storage paths and content types like the app does', () => {
    expect(storagePathFor('NOVA-2', 'Design.PNG', 1700000000000, 'ab12')).toBe('NOVA-2/1700000000000_ab12.png');
    expect(storagePathFor('NOVA-2', 'README', 1, 'x')).toBe('NOVA-2/1_x');
    expect(contentTypeFor('a.pdf')).toBe('application/pdf');
    expect(contentTypeFor('a.unknown')).toBe('application/octet-stream');
  });

  it('writes the report as CSV with a BOM', () => {
    expect(reportCsv([{ issue_key: 'NOVA-2', attachment_id: '1', file_name: 'a,b.png', size_bytes: 3, status: 'uploaded', detail: '', livo_path: 'x' }]))
      .toBe('\uFEFFissue_key,attachment_id,file_name,size_bytes,status,detail,livo_path\nNOVA-2,1,"a,b.png",3,uploaded,,x\n');
  });
});

describe('signing in to a Docker install', () => {
  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  /** A Kong-shaped fake: the api-tokens exchange plus one PostgREST table. */
  function fakeInstall({ hasApiTokens = true } = {}) {
    const calls = [];
    let exchanges = 0;
    const fetch = async (url, init = {}) => {
      const { pathname } = new URL(url);
      calls.push({ pathname, headers: init.headers || {} });
      if (pathname === '/functions/v1/api-tokens/exchange') {
        if (!hasApiTokens) return json(404, { message: 'function not found' });
        if (init.headers?.Authorization !== 'Bearer livo_pat_0123') {
          return json(401, { ok: false, error: 'invalid_token', message: 'API 金鑰無效或已撤銷' });
        }
        exchanges++;
        const now = Math.floor(Date.now() / 1000);
        return json(200, {
          access_token: `jwt-${exchanges}`,
          token_type: 'bearer',
          expires_in: 900,
          expires_at: now + 900,
          member: { id: 'm-ai', name: 'AI 助理', role: 'admin' },
        });
      }
      if (pathname === '/rest/v1/tasks') return json(200, [{ id: 'NOVA-1', task_key: 'NOVA-1' }]);
      return json(404, { message: 'not found' });
    };
    return { fetch, calls, exchanges: () => exchanges };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('trades an API key for a login JWT and trades again before it runs out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const install = fakeInstall();
    vi.stubGlobal('fetch', install.fetch);

    const livo = await connectLivo({ supabase: 'http://localhost:8000/', anonKey: 'anon', token: 'livo_pat_0123' });
    expect(livo.kind).toBe('docker');
    expect(livo.memberId).toBe('m-ai');
    expect(livo.maxUploadBytes).toBe(200 * 1024 * 1024);
    expect(await livo.select('tasks', 'id,task_key', { task_key: ['NOVA-1'] })).toEqual([{ id: 'NOVA-1', task_key: 'NOVA-1' }]);
    expect(install.calls.at(-1).headers).toMatchObject({ apikey: 'anon', Authorization: 'Bearer jwt-1' });
    expect(install.exchanges()).toBe(1);

    vi.setSystemTime(new Date('2026-10-01T00:09:00Z')); // 6 minutes left: keep the token
    await livo.select('tasks', 'id');
    expect(install.exchanges()).toBe(1);

    vi.setSystemTime(new Date('2026-10-01T00:11:00Z')); // 4 minutes left: trade again
    await livo.select('tasks', 'id');
    expect(install.exchanges()).toBe(2);
    expect(install.calls.at(-1).headers).toMatchObject({ Authorization: 'Bearer jwt-2' });
  });

  it('explains a refused key and an install without API keys', async () => {
    vi.stubGlobal('fetch', fakeInstall().fetch);
    await expect(connectLivo({ supabase: 'http://localhost:8000', anonKey: 'anon', token: 'livo_pat_wrong' }))
      .rejects.toThrow('API 金鑰無效或已撤銷');

    vi.stubGlobal('fetch', fakeInstall({ hasApiTokens: false }).fetch);
    await expect(connectLivo({ supabase: 'http://localhost:8000', anonKey: 'anon', token: 'livo_pat_0123' }))
      .rejects.toThrow('--email');
  });

  it('still takes a raw login JWT as is', async () => {
    const install = fakeInstall();
    vi.stubGlobal('fetch', install.fetch);
    const livo = await connectLivo({ supabase: 'http://localhost:8000', anonKey: 'anon', token: 'eyJhbGciOi.raw.jwt' });
    await livo.select('tasks', 'id');
    expect(install.exchanges()).toBe(0);
    expect(install.calls.at(-1).headers).toMatchObject({ Authorization: 'Bearer eyJhbGciOi.raw.jwt' });
    expect(livo.memberId).toBeNull();
  });
});
