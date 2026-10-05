/**
 * Whether rich text holds anything a reader would see. An emptied editor leaves
 * markup such as "<p></p>" or "<p><br></p>", which must not satisfy a required field.
 */
export function hasRichTextContent(html: string | null | undefined): boolean {
  if (!html) return false;
  if (/<(img|video|iframe|hr)\b/i.test(html)) return true;
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;|\u00a0/g, ' ').trim().length > 0;
}
