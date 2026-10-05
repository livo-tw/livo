import { afterEach, describe, expect, it } from 'vitest';
import { readBoardDisplay, writeBoardDisplay } from '@/lib/boardDisplay';
import { DEFAULT_CARD_FIELDS } from '@/lib/fieldRegistry';

afterEach(() => localStorage.clear());

describe('board card display', () => {
  it('is remembered in this browser', () => {
    const shown = readBoardDisplay();
    expect(shown).toEqual({ cardFields: DEFAULT_CARD_FIELDS, subtaskMode: 'independent', customCardFields: {} });
    const field = Object.keys(DEFAULT_CARD_FIELDS)[0] as keyof typeof DEFAULT_CARD_FIELDS;
    writeBoardDisplay({ cardFields: { ...DEFAULT_CARD_FIELDS, [field]: !DEFAULT_CARD_FIELDS[field] }, subtaskMode: 'nested', customCardFields: { cf1: true } });
    const again = readBoardDisplay();
    expect(again.cardFields[field]).toBe(!DEFAULT_CARD_FIELDS[field]);
    expect(again.subtaskMode).toBe('nested');
    expect(again.customCardFields).toEqual({ cf1: true });
  });

  it('ignores damaged or unknown stored values', () => {
    localStorage.setItem('livo.boardDisplay', JSON.stringify({ cardFields: { notAField: true, assignee: 'yes' }, subtaskMode: 'sideways', customCardFields: { cf1: 'x' } }));
    expect(readBoardDisplay()).toEqual({ cardFields: DEFAULT_CARD_FIELDS, subtaskMode: 'independent', customCardFields: {} });
    localStorage.setItem('livo.boardDisplay', '{broken');
    expect(readBoardDisplay().subtaskMode).toBe('independent');
  });
});
