import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCommentOrder } from '@/hooks/useCommentOrder';
import { sortComments } from '@/lib/commentOrdering';

describe('card comment ordering', () => {
  it('orders mixed ISO offsets by the actual instant instead of the timestamp text', () => {
    const comments = [
      { id: 'oldest', createdAt: '2026-11-04T09:45:00+09:00' },
      { id: 'newest', createdAt: '2026-11-04T10:00:00+08:00' },
      { id: 'middle', createdAt: '2026-11-04T01:30:00Z' },
    ];

    expect(sortComments(comments).map(comment => comment.id))
      .toEqual(['newest', 'middle', 'oldest']);
  });

  it('uses the same ascending ID tie-break regardless of input order or ISO formatting', () => {
    const comments = [
      { id: 'comment-c', createdAt: '2026-11-04T02:00:00.000Z' },
      { id: 'comment-a', createdAt: '2026-11-04T10:00:00+08:00' },
      { id: 'comment-b', createdAt: '2026-11-04T02:00:00Z' },
    ];
    const expected = ['comment-a', 'comment-b', 'comment-c'];

    expect(sortComments(comments).map(comment => comment.id)).toEqual(expected);
    expect(sortComments([...comments].reverse()).map(comment => comment.id)).toEqual(expected);
  });

  it('keeps invalid timestamps after every valid date, including dates before the Unix epoch', () => {
    const comments = [
      { id: 'invalid-b', createdAt: 'not-a-date' },
      { id: 'before-epoch', createdAt: '1960-01-01T00:00:00Z' },
      { id: 'invalid-a', createdAt: '' },
      { id: 'recent', createdAt: '2026-11-04T02:00:00Z' },
    ];

    expect(sortComments(comments).map(comment => comment.id))
      .toEqual(['recent', 'before-epoch', 'invalid-a', 'invalid-b']);
  });

  it('sorts a copy without mutating the shared array or replacing comment objects', () => {
    const older = Object.freeze({ id: 'older', createdAt: '2026-11-03T01:00:00Z', body: 'Earlier note' });
    const newer = Object.freeze({ id: 'newer', createdAt: '2026-11-04T01:00:00Z', body: 'Latest note' });
    const comments = Object.freeze([older, newer]);

    const sorted = sortComments(comments);

    expect(comments).toEqual([older, newer]);
    expect(sorted).not.toBe(comments);
    expect(sorted[0]).toBe(newer);
    expect(sorted[1]).toBe(older);
    expect(sorted[0].body).toBe('Latest note');
  });

  it('puts an appended optimistic or realtime comment above the existing discussion', () => {
    const existing = [
      { id: 'first', createdAt: '2026-11-04T01:00:00Z' },
      { id: 'second', createdAt: '2026-11-04T02:00:00Z' },
    ];
    const received = { id: 'received', createdAt: '2026-11-04T03:00:00Z' };

    expect(sortComments([...existing, received]).map(comment => comment.id))
      .toEqual(['received', 'second', 'first']);
    expect(existing.map(comment => comment.id)).toEqual(['first', 'second']);
  });

  it('handles an empty discussion', () => {
    expect(sortComments([])).toEqual([]);
  });

  it('preserves a single comment and its attachment fields', () => {
    const comment = {
      id: 'only', createdAt: '2026-11-04T03:00:00Z',
      attachmentUrl: 'https://example.com/attachment.pdf', attachmentName: 'Example attachment.pdf',
    };

    expect(sortComments([comment])).toEqual([comment]);
  });

  it('places a newly received comment last when oldest first is selected', () => {
    const comments = [
      { id: 'unknown', createdAt: '' },
      { id: 'first', createdAt: '2026-11-04T01:00:00Z' },
      { id: 'received', createdAt: '2026-11-04T03:00:00Z' },
    ];
    expect(sortComments(comments, 'oldest').map(comment => comment.id))
      .toEqual(['first', 'received', 'unknown']);
  });

  it('remembers the chosen order for the same member and defaults a different member to newest first', () => {
    const memberId = 'comment-order-example';
    const key = `livo_comment_order:v1:${memberId}`;
    localStorage.removeItem(key);
    try {
      const card = renderHook(({ id }) => useCommentOrder(id), { initialProps: { id: memberId } });
      expect(card.result.current[0]).toBe('newest');
      act(() => card.result.current[1]('oldest'));
      expect(card.result.current[0]).toBe('oldest');
      card.rerender({ id: 'other-comment-order-example' });
      expect(card.result.current[0]).toBe('newest');
      card.unmount();

      const nextCard = renderHook(() => useCommentOrder(memberId));
      expect(nextCard.result.current[0]).toBe('oldest');
      nextCard.unmount();
    } finally {
      localStorage.removeItem(key);
    }
  });
});
