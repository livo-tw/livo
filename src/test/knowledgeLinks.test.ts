// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderKnowledgeHtml } from '../lib/knowledgeHtml';

function view(html: string) {
  const div = document.createElement('div');
  div.innerHTML = renderKnowledgeHtml(html);
  return div;
}

describe('knowledge reference links', () => {
  it('opens imported and newly pasted web references in a separate tab', () => {
    const result = view('<p><a href="https://example.com/source" target="_blank">Imported</a> <a href="//example.com/document">New</a></p>');
    expect(result.querySelectorAll('a')).toHaveLength(2);
    for (const anchor of result.querySelectorAll('a')) {
      expect(anchor.target).toBe('_blank');
      expect(anchor.rel).toBe('noopener noreferrer');
    }
  });
  it('continues to remove script URLs and event handlers', () => {
    const result = view('<script>bad()</script><a href="javascript:bad()" onclick="bad()">Unsafe</a><img src="x" onerror="bad()">');
    expect(result.querySelector('script')).toBeNull();
    expect(result.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(result.querySelector('a')?.hasAttribute('onclick')).toBe(false);
    expect(result.querySelector('img')?.hasAttribute('onerror')).toBe(false);
  });
  it('keeps in-page navigation and approved document formatting intact', () => {
    const result = view('<h2 style="font-weight:650">Title</h2><a href="#details">Details</a><table><tbody><tr><td>Value</td></tr></tbody></table>');
    expect(result.querySelector('a')?.getAttribute('href')).toBe('#details');
    expect(result.querySelector('a')?.hasAttribute('target')).toBe(false);
    expect(result.querySelector('h2')?.style.fontWeight).toBe('650');
    expect(result.querySelector('td')?.textContent).toBe('Value');
  });
});
