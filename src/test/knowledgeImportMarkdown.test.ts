import { describe, expect, it } from 'vitest';
import { parseMarkdownLocally, parseWithProcessor } from '../../worker/src/knowledgeImport';

const md = (text: string) => parseMarkdownLocally(new TextEncoder().encode(text));

describe('Markdown import without the private processor', () => {
  it('converts the common Markdown structure into passive HTML', async () => {
    const result = await md([
      '# Release notes', '', 'Intro with **bold**, *italic*, ~~old~~ and `a<b`.', '',
      '- first', '  - nested', '- second', '', '1. one', '2. two', '',
      '> quoted **text**', '', '```', 'if (a < b && c) {}', '```', '',
      '| Name | Value |', '| --- | --- |', '| a | 1 |', '', '---', 'Setext', '======',
    ].join('\n'));
    expect(result.body).toContain('<h1>Release notes</h1>');
    expect(result.body).toContain('<p>Intro with <strong>bold</strong>, <em>italic</em>, <s>old</s> and <code>a&lt;b</code>.</p>');
    expect(result.body).toContain('<ul><li>first<ul><li>nested</li></ul></li><li>second</li></ul>');
    expect(result.body).toContain('<ol><li>one</li><li>two</li></ol>');
    expect(result.body).toContain('<blockquote><p>quoted <strong>text</strong></p></blockquote>');
    expect(result.body).toContain('<pre><code>if (a &lt; b &amp;&amp; c) {}</code></pre>');
    expect(result.body).toContain('<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>');
    expect(result.body).toContain('<hr><h1>Setext</h1>');
    expect(result).toMatchObject({ pages: [], assets: [], incomplete: false, needs_review: false, parser_version: 'livo-import-md-builtin-1' });
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never produces active content: raw HTML is text, images are not fetched, unsafe links lose their target', async () => {
    const result = await md('<img src=x onerror=alert(1)> <script>alert(1)</script>\n\n![pixel](https://example.com/p.png)\n\n[ok](https://example.com/a?b=1&c=2) [bad](javascript:alert(1)) [anchor](#top) <https://example.com/auto>\n\n- [x] done');
    expect(result.body).not.toMatch(/<img|<script|javascript:/i);
    expect(result.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(result.body).toContain('[image: pixel]');
    expect(result.body).toContain('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(result.body).toContain('<a href="#top" target="_blank" rel="noopener noreferrer">anchor</a>');
    expect(result.body).toContain('<a href="https://example.com/auto" target="_blank" rel="noopener noreferrer">https://example.com/auto</a>');
    expect(result.warnings).toEqual(['historical_checkboxes', 'embedded_or_relative_content_not_converted']);
    expect(result.needs_review).toBe(true);
  });

  it('rejects empty, oversized and non-UTF-8 files with known errors', async () => {
    await expect(md('   \n')).rejects.toMatchObject({ code: 'empty_document' });
    await expect(md('x'.repeat(800_001))).rejects.toMatchObject({ code: 'parsed_document_too_large' });
    await expect(parseMarkdownLocally(new Uint8Array([0xff, 0xfe, 0x41]))).rejects.toMatchObject({ code: 'invalid_document' });
  });

  it('uses the built-in conversion only for Markdown and only when no processor is set', async () => {
    const bytes = new TextEncoder().encode('# Note');
    expect((await parseWithProcessor({}, 'md', bytes)).body).toBe('<h1>Note</h1>');
    // A byte-order mark from Windows editors is dropped, and private-use characters cannot forge kept HTML.
    expect((await parseMarkdownLocally(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]))).body).toBe('<h1>Note</h1>');
    expect((await md('a \uE0000\uE001 [x](https://example.com)')).body).toBe('<p>a 0 <a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a></p>');
    await expect(parseWithProcessor({}, 'docx', bytes)).rejects.toMatchObject({ code: 'processor_not_configured' });
    await expect(parseWithProcessor({ processorUrl: 'http://processor:8080', processorToken: 'short' }, 'md', bytes)).rejects.toMatchObject({ code: 'processor_not_configured' });
  });
});
