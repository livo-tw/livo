import { USE_CF_BACKEND } from '@/lib/apiBase';

// Per-file upload limit enforced in the UI before a file is sent.
// - Cloudflare backend (cloud / wrangler dev): the Worker caps uploads, and the
//   UI has always allowed 2 MB per file.
// - Docker self-host: Supabase Storage's FILE_SIZE_LIMIT, which docker/.env sets
//   to 200 MB by default. If an install raises it, files above 200 MB still have
//   to go through the API instead of the browser.
export const MAX_UPLOAD_BYTES = USE_CF_BACKEND ? 2 * 1024 * 1024 : 200 * 1024 * 1024;
export const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / 1024 / 1024;
