/** The first `max` user-perceived characters (an emoji counts as one). */
export function clipAvatarText(value: string, max = 2): string {
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  const parts = Segmenter
    ? Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(value), s => s.segment)
    : Array.from(value);
  return parts.slice(0, max).join('');
}
