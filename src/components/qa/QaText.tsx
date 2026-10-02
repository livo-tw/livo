/** Keep imported reports as plain text while making their source URLs usable. */
export function QaText({ text }: { text: string }) {
  return <>{text.split(/(https?:\/\/[^\s<>]+)/g).map((part, index) => {
    if (!/^https?:\/\//.test(part)) return part;
    const url = part.replace(/[.,;!?，。；！？、）)\]}]+$/, '');
    return <span key={index}><a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline">{url}</a>{part.slice(url.length)}</span>;
  })}</>;
}
