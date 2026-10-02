import { Extension, Mark } from '@tiptap/core';

const colors = {
  key: ['#1d4ed8', '#eff6ff'], pending: ['#92400e', '#fffbeb'], limit: ['#991b1b', '#fef2f2'],
};

/** Preserve the knowledge library's semantic highlights through an edit/save cycle. */
export const KnowledgeHighlight = Mark.create({
  name: 'knowledgeHighlight',
  inclusive: false,
  addAttributes() {
    return { kind: { default: 'key', parseHTML: element => element.getAttribute('data-kb-highlight') } };
  },
  parseHTML() {
    return [{ tag: 'mark[data-kb-highlight]', getAttrs: element => {
      const kind = element.getAttribute('data-kb-highlight');
      return kind && Object.prototype.hasOwnProperty.call(colors, kind) ? { kind } : false;
    } }];
  },
  renderHTML({ mark }) {
    const kind = mark.attrs.kind as keyof typeof colors;
    const [color, background] = Object.prototype.hasOwnProperty.call(colors, kind) ? colors[kind] : colors.key;
    return ['mark', { 'data-kb-highlight': kind, style: `color:${color};background-color:${background};font-weight:650;padding:0 .12em;border-radius:3px;` }, 0];
  },
});

/** TextStyle/Color already preserve text color; also retain pale background emphasis. */
export const KnowledgeTextBackground = Extension.create({
  name: 'knowledgeTextBackground',
  addGlobalAttributes() {
    return [{ types: ['textStyle'], attributes: { backgroundColor: {
      default: null,
      parseHTML: element => element.style.backgroundColor || null,
      renderHTML: attributes => attributes.backgroundColor ? { style: `background-color:${attributes.backgroundColor}` } : {},
    } } }];
  },
});
