import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QaText } from '@/components/qa/QaText';

describe('QA plain-text source links', () => {
  it('links an original URL without swallowing sentence punctuation', () => {
    render(<p><QaText text="Source: https://example.com/bugs?id=42。" /></p>);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://example.com/bugs?id=42');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.parentElement?.textContent).toBe('https://example.com/bugs?id=42。');
  });
  it('keeps HTML and non-web schemes inert', () => {
    const { container } = render(<QaText text={'<img src=x onerror=alert(1)> javascript:alert(1)'} />);
    expect(container.querySelector('img, a, script')).toBeNull();
    expect(container.textContent).toContain('<img');
  });
});
