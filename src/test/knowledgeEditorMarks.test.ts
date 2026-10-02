import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import { KnowledgeHighlight, KnowledgeTextBackground } from '@/lib/knowledgeEditorMarks';

describe('knowledge emphasis survives editing', () => {
  it('preserves all semantic colors, ordinary colored backgrounds and literal text', () => {
    const editor = new Editor({ extensions: [StarterKit, TextStyle, Color, KnowledgeHighlight, KnowledgeTextBackground],
      content: '<p>Rule <mark data-kb-highlight="key" style="color:#1d4ed8;background-color:#eff6ff">Match the approved version</mark>. <mark data-kb-highlight="pending">Pending confirmation</mark>. <mark data-kb-highlight="limit">Do not publish</mark>. <span style="color:#92400e;background-color:#fffbeb">Meeting follow-up</span>.</p>' });
    try {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' More details.');
      const first = editor.getHTML();
      editor.commands.setContent(first);
      const document = new DOMParser().parseFromString(editor.getHTML(), 'text/html');
      expect(document.body.textContent).toBe('Rule Match the approved version. Pending confirmation. Do not publish. Meeting follow-up. More details.');
      expect(document.querySelectorAll('mark')).toHaveLength(3);
      const expected = { key: ['rgb(29, 78, 216)', 'rgb(239, 246, 255)'], pending: ['rgb(146, 64, 14)', 'rgb(255, 251, 235)'], limit: ['rgb(153, 27, 27)', 'rgb(254, 242, 242)'] };
      for (const [kind, [color, background]] of Object.entries(expected)) {
        const mark = document.querySelector<HTMLElement>(`mark[data-kb-highlight="${kind}"]`)!;
        expect(mark.style.color).toBe(color); expect(mark.style.backgroundColor).toBe(background);
      }
      expect(document.querySelector<HTMLElement>('span')?.style.backgroundColor).toBe('rgb(255, 251, 235)');
    } finally { editor.destroy(); }
  });
});
