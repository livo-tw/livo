// Pure helpers for scripts/jira-attachments.mjs (unit-tested on their own).

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic', avif: 'image/avif', ico: 'image/x-icon',
  pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', xml: 'application/xml', zip: 'application/zip', '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar', gz: 'application/gzip', tar: 'application/x-tar',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
};

export function extensionOf(fileName) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(fileName || '');
  return m ? m[1].toLowerCase() : '';
}

export function contentTypeFor(fileName) {
  return MIME[extensionOf(fileName)] || 'application/octet-stream';
}

export function isImageName(fileName) {
  return contentTypeFor(fileName).startsWith('image/');
}

/** Same layout as the app's own attachment uploads: <task id>/<ms>_<rand>.<ext>. */
export function storagePathFor(taskId, fileName, now = Date.now(), rand = Math.random().toString(36).slice(2, 6)) {
  const ext = extensionOf(fileName);
  return `${taskId}/${now}_${rand}${ext ? `.${ext}` : ''}`;
}

/** "50", "50MB", "1.5GiB" → bytes (MB/MiB both mean 1024²). null when empty, NaN when invalid. */
export function parseSize(text) {
  if (text === undefined || text === null || String(text).trim() === '') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|kib|k|mb|mib|m|gb|gib|g)?\s*$/i.exec(String(text));
  if (!m) return NaN;
  const unit = (m[2] || 'mb').toLowerCase();
  const mult = unit.startsWith('g') ? 1024 ** 3 : unit.startsWith('m') ? 1024 ** 2 : unit.startsWith('k') ? 1024 : 1;
  return Math.round(parseFloat(m[1]) * mult);
}

export function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unescapeHtml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/**
 * Replaces inline-image references with the uploaded files:
 *   "[圖片: name.png]"  — what the Jira import turned "!name.png|…!" into
 *   "!name.png|…!" / "!name.png!" — raw Jira markup (HTML descriptions keep it)
 * Only names of this task's attachments are touched. Images become <img>,
 * anything else a link.
 * @param {string} html
 * @param {Map<string, string>} urlByName  original file name → public URL
 */
export function replaceInlineImages(html, urlByName) {
  if (!html || urlByName.size === 0) return { html, replaced: 0 };
  let replaced = 0;
  const render = (name) => {
    const url = urlByName.get(name);
    if (!url) return null;
    replaced++;
    return isImageName(name)
      ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(name)}">`
      : `<a href="${escapeHtml(url)}">${escapeHtml(name)}</a>`;
  };
  const out = html
    .replace(/\[圖片: ([^\]\n]+)\]/g, (full, raw) => render(unescapeHtml(raw.trim())) ?? full)
    .replace(/!([^!\n|<>]+?)(?:\|[^!\n<>]*)?!/g, (full, raw) => render(unescapeHtml(raw.trim())) ?? full);
  return { html: out, replaced };
}

const csvCell = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const REPORT_COLUMNS = ['issue_key', 'attachment_id', 'file_name', 'size_bytes', 'status', 'detail', 'livo_path'];

export function reportCsv(rows) {
  return '\uFEFF' + [REPORT_COLUMNS, ...rows.map((r) => REPORT_COLUMNS.map((c) => r[c]))]
    .map((r) => r.map(csvCell).join(','))
    .join('\n') + '\n';
}
