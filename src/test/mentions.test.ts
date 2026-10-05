import { describe, expect, it } from 'vitest';
import { mentionedMembers, mentionSuggestions, mentionText, typedMentions } from '@/lib/mentions';

// Fictional people only.
const people = [
  { id: 'ann', name: 'Ann', email: 'ann@example.com', sortOrder: 3 },
  { id: 'anna', name: 'Anna Lee', email: 'anna.lee@example.com', sortOrder: 2 },
  { id: 'cjk', name: '林小雨', email: 'rain@example.com', sortOrder: 1 },
  { id: 'cjk2', name: '林小', email: 'lin@example.com', sortOrder: 4 },
  { id: 'twin1', name: 'Sam', email: 'sam.one@example.com' },
  { id: 'twin2', name: 'Sam', email: 'sam.two@example.com' },
  { id: 'gone', name: 'Old Member', email: 'old@example.com', isActive: false },
  { id: 'nologin', name: 'Imported', email: 'm-9@import.invalid' },
];
const ids = (rows: { id: string }[]) => rows.map(row => row.id);

describe('typed mentions', () => {
  it('reads "@Name" typed without picking from the list', () => {
    expect(ids(typedMentions('@Ann 10/2 done, please check staging', people))).toEqual(['ann']);
    expect(ids(typedMentions('please check @ann.', people))).toEqual(['ann']);
    expect(ids(typedMentions('Hi @Anna Lee, see above', people))).toEqual(['anna']);
  });
  it('takes the e-mail account too, for members shown under another name', () => {
    expect(ids(typedMentions('@rain can you review', people))).toEqual(['cjk']);
  });
  it('lets a CJK name run into the sentence and prefers the longest name', () => {
    expect(ids(typedMentions('@林小雨請確認', people))).toEqual(['cjk']);
    expect(ids(typedMentions('@林小 看一下', people))).toEqual(['cjk2']);
  });
  it('ignores e-mail addresses, longer words, shared names and inactive members', () => {
    expect(typedMentions('write to ann@example.com', people)).toEqual([]);
    expect(typedMentions('@Annex is a file', people)).toEqual([]);
    expect(typedMentions('@Sam please', people)).toEqual([]);
    expect(ids(typedMentions('@sam.two please', people))).toEqual(['twin2']);
    expect(typedMentions('@Old Member', people)).toEqual([]);
    expect(typedMentions('@m-9', people)).toEqual([]);
  });
});

describe('mentioned members in editor HTML', () => {
  it('counts a picked mention and a typed one once each', () => {
    const html = '<p><span class="mention" data-id="anna">@Anna Lee</span>&nbsp;and @Ann</p><p>@Ann again</p>';
    expect(mentionText(html)).toContain('@Anna Lee and @Ann');
    expect(ids(mentionedMembers(html, people))).toEqual(['anna', 'ann']);
  });
  it('keeps a picked mention when the name is shared, and drops unknown or inactive ids', () => {
    expect(ids(mentionedMembers('<span class="mention" data-id="twin2">@Sam</span>', people))).toEqual(['twin2']);
    expect(mentionedMembers('<span data-id="gone">@Old Member</span><span data-id="nobody">@X</span>', people)).toEqual([]);
  });
  it('does not join words across paragraphs', () => {
    expect(ids(mentionedMembers('<p>@Ann</p><p>exed</p>', people))).toEqual(['ann']);
  });
});

describe('the @ list', () => {
  it('finds names first, then e-mail accounts, and leaves inactive members out', () => {
    expect(ids(mentionSuggestions(people, 'ann'))).toEqual(['anna', 'ann']);
    expect(ids(mentionSuggestions(people, 'rain'))).toEqual(['cjk']);
    expect(ids(mentionSuggestions(people, 'old'))).toEqual([]);
    expect(ids(mentionSuggestions(people, 'm-9'))).toEqual([]);
    expect(mentionSuggestions(people, '')).toHaveLength(7);
  });
});
