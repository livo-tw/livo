/** The task provider owns its reservations; QA issue IDs are never task IDs. */
export const COMMENT_FILE_LIMIT = 200 * 1024 * 1024;
export const COMMENT_PART_BYTES = 5 * 1024 * 1024;
export const COMMENT_FILE_COUNT = 10;
export const COMMENT_FILE_TYPES: Record<string, string[]> = {
  'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'], 'image/gif': ['gif'],
  'video/mp4': ['mp4'], 'video/webm': ['webm'], 'application/pdf': ['pdf'],
  'text/plain': ['txt', 'log'], 'text/csv': ['csv'], 'application/json': ['json'],
};
export class CommentAttachmentError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export function commentNeed(ok: unknown, code: string, status = 400): asserts ok {
  if (!ok) throw new CommentAttachmentError(code, status);
}
export function commentFileError(file: { name: string; type: string; size: number }): 'file_size' | 'file_type' | 'file_name' | undefined {
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > COMMENT_FILE_LIMIT) return 'file_size';
  if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 180 || /[\x00-\x1f\\/]/.test(file.name)) return 'file_name';
  if (typeof file.type !== 'string' || !COMMENT_FILE_TYPES[file.type]?.includes(file.name.split('.').pop()!.toLowerCase())) return 'file_type';
}
export function commentSignature(mime: string, bytes: Uint8Array): void {
  const text = (a: number, b: number) => new TextDecoder().decode(bytes.slice(a, b));
  let valid = false;
  if (mime === 'image/png') valid = [137,80,78,71,13,10,26,10].every((x,i) => bytes[i] === x);
  else if (mime === 'image/jpeg') valid = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  else if (mime === 'image/gif') valid = ['GIF87a','GIF89a'].includes(text(0,6));
  else if (mime === 'image/webp') valid = text(0,4) === 'RIFF' && text(8,12) === 'WEBP';
  else if (mime === 'video/mp4') valid = bytes.length >= 12 && text(4,8) === 'ftyp';
  else if (mime === 'video/webm') valid = [0x1a,0x45,0xdf,0xa3].every((x,i) => bytes[i] === x);
  else if (mime === 'application/pdf') valid = text(0,5) === '%PDF-';
  else if (mime.startsWith('text/') || mime === 'application/json') {
    try { const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.slice(0,8192), { stream: true }); valid = !value.includes('\0') && !/<\s*(?:!doctype\s+html|html|svg|script)\b/i.test(value); } catch { valid = false; }
  }
  commentNeed(valid, 'file_signature');
}
export function commentUUID(value: unknown): string {
  commentNeed(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), 'invalid_id');
  return value;
}
export function commentId(value: unknown): string {
  commentNeed(typeof value === 'string' && /^[\w:-]{1,180}$/.test(value), 'invalid_id'); return value;
}
export function commentPublishInput(body: Record<string, unknown>) {
  const taskId = commentId(body.taskId), commandId = commentUUID(body.commandId);
  commentNeed(typeof body.body === 'string' && body.body.length <= 20000, 'invalid_comment');
  const uploadIds = body.uploadIds ?? [], mentionIds = body.mentionIds ?? [];
  commentNeed(Array.isArray(uploadIds) && uploadIds.length <= COMMENT_FILE_COUNT && new Set(uploadIds).size === uploadIds.length, 'attachment_count');
  commentNeed(Array.isArray(mentionIds) && mentionIds.length <= 100, 'invalid_mentions');
  const uploads = uploadIds.map(commentUUID), mentions = [...new Set(mentionIds.map(commentId))];
  commentNeed(body.body.replace(/<[^>]*>/g, '').trim() || uploads.length, 'invalid_comment');
  return { taskId, commandId, body: body.body.trim(), uploadIds: uploads, mentionIds: mentions };
}
export type CommentMedia = { id: string; commentId?: string; taskId: string; fileName: string; mimeType: string; size: number };
