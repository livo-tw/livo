import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Color from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import Image from '@tiptap/extension-image';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { useRef, useCallback, useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Heading1, Heading2, Heading3, List, ListOrdered,
  ImageIcon, Palette, Undo, Redo, Quote, TableIcon,
  Plus, Minus, Rows3, Columns3, Trash2,
} from 'lucide-react';
import i18n from '@/i18n';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from '@/lib/uploadLimits';
import type { User } from '@/types';
import type { Editor } from '@tiptap/core';
import { KnowledgeHighlight, KnowledgeTextBackground } from '@/lib/knowledgeEditorMarks';

interface SuggestionProps {
  editor: Editor;
  clientRect?: () => DOMRect;
  event: KeyboardEvent;
  id?: string;
  label?: string;
  range: { from: number; to: number };
}

const TEXT_COLORS = [
  { labelKey: 'color.black', value: '#000000' },
  { labelKey: 'color.red', value: '#FF5630' },
  { labelKey: 'color.orange', value: '#FF8B00' },
  { labelKey: 'color.green', value: '#36B37E' },
  { labelKey: 'color.blue', value: '#0065FF' },
  { labelKey: 'color.purple', value: '#6554C0' },
  { labelKey: 'color.gray', value: '#97A0AF' },
];

interface RichTextEditorProps {
  content: string;
  onChange: (html: string) => void;
  placeholder?: string;
  editable?: boolean;
  minimal?: boolean;
  members?: User[];
  onMention?: (userId: string) => void;
  imageUploadPrefix?: string;
  /** Knowledge pages use private attachments, not public inline uploads. */
  allowImageUpload?: boolean;
}

// Mention suggestion list component
interface MentionListProps {
  items: User[];
  command: (attrs: { id: string; label: string }) => void;
}

const MentionList = forwardRef<{ onKeyDown: (props: { event: KeyboardEvent }) => boolean }, MentionListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => setSelectedIndex(0), [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === 'ArrowUp') {
          setSelectedIndex((selectedIndex + items.length - 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowDown') {
          setSelectedIndex((selectedIndex + 1) % items.length);
          return true;
        }
        if (event.key === 'Enter') {
          if (items[selectedIndex]) {
            command({ id: items[selectedIndex].id, label: items[selectedIndex].name });
          }
          return true;
        }
        return false;
      },
    }));

    return (
      <div className="bg-card border border-border rounded-lg shadow-lg py-1 max-h-48 overflow-y-auto z-[100]">
        {items.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">{i18n.t('editor.noMembersFound')}</div>
        ) : (
          items.map((item, index) => (
            <button
              key={item.id}
              onClick={() => command({ id: item.id, label: item.name })}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                index === selectedIndex ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent'
              }`}
            >
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white flex-shrink-0"
                style={{ backgroundColor: item.color }}
              >
                {item.avatar}
              </div>
              <span>{item.name}</span>
            </button>
          ))
        )}
      </div>
    );
  }
);
MentionList.displayName = 'MentionList';

const RichTextEditor = ({ content, onChange, placeholder = '', editable = true, minimal = false, members = [], onMention, imageUploadPrefix = 'uploads', allowImageUpload = true }: RichTextEditorProps) => {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const mentionCallbackRef = useRef(onMention);
  mentionCallbackRef.current = onMention;
  const membersRef = useRef(members);
  membersRef.current = members;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      TextStyle,
      Color,
      KnowledgeHighlight,
      KnowledgeTextBackground,
      Image.configure({ inline: false, allowBase64: true }),
      Underline,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder }),
      Mention.configure({
        HTMLAttributes: {
          class: 'mention',
        },
        renderHTML({ options, node }) {
          return ['span', { class: 'mention', 'data-id': node.attrs.id }, `@${node.attrs.label}`];
        },
        suggestion: {
          items: ({ query }: { query: string }) => {
            return membersRef.current
              .filter(m => m.name.toLowerCase().includes(query.toLowerCase()))
              .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
          },
          render: () => {
            let component: ReactRenderer<Record<string, unknown>> | null = null;
            let popup: HTMLDivElement | null = null;

            return {
              onStart: (props: SuggestionProps) => {
                component = new ReactRenderer(MentionList, {
                  props,
                  editor: props.editor,
                });

                popup = document.createElement('div');
                popup.style.position = 'fixed';
                popup.style.zIndex = '9999';
                document.body.appendChild(popup);

                const rect = props.clientRect?.();
                if (rect) {
                  const top = rect.bottom + 4;
                  const left = rect.left;
                  // Keep within viewport horizontally
                  popup.style.left = `${Math.min(left, window.innerWidth - 200)}px`;
                  // Flip above cursor if near bottom of viewport
                  popup.style.top = top + 200 > window.innerHeight
                    ? `${rect.top - 4}px`
                    : `${top}px`;
                  if (top + 200 > window.innerHeight) {
                    popup.style.transform = 'translateY(-100%)';
                  }
                }
                popup.appendChild(component.element);
              },
              onUpdate: (props: SuggestionProps) => {
                component?.updateProps(props);
                if (popup) {
                  const rect = props.clientRect?.();
                  if (rect) {
                    const top = rect.bottom + 4;
                    const left = rect.left;
                    popup.style.left = `${Math.min(left, window.innerWidth - 200)}px`;
                    popup.style.transform = '';
                    if (top + 200 > window.innerHeight) {
                      popup.style.top = `${rect.top - 4}px`;
                      popup.style.transform = 'translateY(-100%)';
                    } else {
                      popup.style.top = `${top}px`;
                    }
                  }
                }
              },
              onKeyDown: (props: SuggestionProps) => {
                if (props.event.key === 'Escape') {
                  popup?.remove();
                  component?.destroy();
                  return true;
                }
                const ref = component?.ref as { onKeyDown?: (props: SuggestionProps) => boolean } | null;
                return ref?.onKeyDown?.(props) || false;
              },
              onExit: () => {
                popup?.remove();
                component?.destroy();
              },
            };
          },
          command: ({ editor, range, props }: { editor: Editor; range: { from: number; to: number }; props: { id: string; label: string } }) => {
            editor.chain().focus().insertContentAt(range, [
              { type: 'mention', attrs: { id: props.id, label: props.label } },
              { type: 'text', text: ' ' },
            ]).run();
            // Fire mention callback
            mentionCallbackRef.current?.(props.id);
          },
        },
      }),
    ],
    content,
    editable,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
  });

  // Sync content from outside
  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content);
    }
  }, [content]);

  useEffect(() => {
    if (editor) {
      editor.setEditable(editable);
    }
  }, [editable, editor]);

  const handleImageUpload = useCallback(async (file: File) => {
    if (!editor || !allowImageUpload) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(i18n.t('taskDetail.attachments.fileSizeExceeded', { files: file.name, size: MAX_UPLOAD_MB }));
      return;
    }
    const ext = file.name.split('.').pop() || 'png';
    const path = `${imageUploadPrefix}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    // Build the URL from the SERVER's effective path (cloud ws/ prefix).
    const { data: up, error } = await supabase.storage.from('task-images').upload(path, file);
    if (error) {
      console.error('Upload error:', error);
      toast.error(error.message); // e.g. beta 空間已滿 — silent drop reads as a bug
      return;
    }
    const { data: { publicUrl } } = supabase.storage.from('task-images').getPublicUrl(up?.path || path);
    editor.chain().focus().setImage({ src: publicUrl }).run();
  }, [editor, imageUploadPrefix, allowImageUpload]);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleImageUpload(file);
    e.target.value = '';
  }, [handleImageUpload]);

  if (!editor) return null;

  const ToolBtn = ({ active, onClick, children, title }: { active?: boolean; onClick: () => void; children: React.ReactNode; title: string }) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`p-1 rounded transition-colors ${active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}
    >
      {children}
    </button>
  );

  return (
    <div className="border border-border rounded-md overflow-hidden bg-card">
      {editable && (
        <div className="flex flex-wrap items-center gap-0.5 px-2 py-1 border-b border-border bg-muted/30">
          <ToolBtn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title={t('editor.bold')}>
            <Bold size={14} />
          </ToolBtn>
          <ToolBtn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title={t('editor.italic')}>
            <Italic size={14} />
          </ToolBtn>
          <ToolBtn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} title={t('editor.underline')}>
            <UnderlineIcon size={14} />
          </ToolBtn>
          <ToolBtn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} title={t('editor.strikethrough')}>
            <Strikethrough size={14} />
          </ToolBtn>

          <span className="w-px h-4 bg-border mx-1" />

          <ToolBtn active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} title={t('editor.heading1')}>
            <Heading1 size={14} />
          </ToolBtn>
          <ToolBtn active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title={t('editor.heading2')}>
            <Heading2 size={14} />
          </ToolBtn>
          <ToolBtn active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title={t('editor.heading3')}>
            <Heading3 size={14} />
          </ToolBtn>

          <span className="w-px h-4 bg-border mx-1" />

          <ToolBtn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} title={t('editor.bulletList')}>
            <List size={14} />
          </ToolBtn>
          <ToolBtn active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} title={t('editor.orderedList')}>
            <ListOrdered size={14} />
          </ToolBtn>
          <ToolBtn active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} title={t('editor.quote')}>
            <Quote size={14} />
          </ToolBtn>

          <span className="w-px h-4 bg-border mx-1" />

          {/* Color picker */}
          <div className="relative">
            <ToolBtn onClick={() => colorInputRef.current?.click()} title={t('editor.textColor')}>
              <Palette size={14} />
            </ToolBtn>
            <div className="absolute top-full left-0 mt-1 z-10 hidden group-focus-within:block">
              <input
                ref={colorInputRef}
                type="color"
                className="w-0 h-0 opacity-0 absolute"
                onChange={(e) => {
                  editor.chain().focus().setColor(e.target.value).run();
                }}
              />
            </div>
          </div>

          {/* Quick colors */}
          {TEXT_COLORS.map(c => (
            <button
              key={c.value}
              type="button"
              title={t(c.labelKey)}
              onClick={() => editor.chain().focus().setColor(c.value).run()}
              className="w-4 h-4 rounded-sm border border-border/50 flex-shrink-0 hover:scale-110 transition-transform"
              style={{ backgroundColor: c.value }}
            />
          ))}

          <span className="w-px h-4 bg-border mx-1" />

          {allowImageUpload && <ToolBtn onClick={() => fileInputRef.current?.click()} title={t('editor.insertImage')}>
            <ImageIcon size={14} />
          </ToolBtn>}
          <ToolBtn onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} title={t('editor.insertTable')}>
            <TableIcon size={14} />
          </ToolBtn>
          {editor.isActive('table') && (
            <>
              <ToolBtn onClick={() => editor.chain().focus().addRowAfter().run()} title={t('editor.addRow')}>
                <span className="flex items-center text-[9px] font-bold">{t('editor.rowShort')}<Plus size={10} /></span>
              </ToolBtn>
              <ToolBtn onClick={() => editor.chain().focus().deleteRow().run()} title={t('editor.deleteRow')}>
                <span className="flex items-center text-[9px] font-bold">{t('editor.rowShort')}<Minus size={10} /></span>
              </ToolBtn>
              <ToolBtn onClick={() => editor.chain().focus().addColumnAfter().run()} title={t('editor.addColumn')}>
                <span className="flex items-center text-[9px] font-bold">{t('editor.columnShort')}<Plus size={10} /></span>
              </ToolBtn>
              <ToolBtn onClick={() => editor.chain().focus().deleteColumn().run()} title={t('editor.deleteColumn')}>
                <span className="flex items-center text-[9px] font-bold">{t('editor.columnShort')}<Minus size={10} /></span>
              </ToolBtn>
              <ToolBtn onClick={() => editor.chain().focus().deleteTable().run()} title={t('editor.deleteTable')}>
                <Trash2 size={13} />
              </ToolBtn>
            </>
          )}

          <span className="w-px h-4 bg-border mx-1" />

          <ToolBtn onClick={() => editor.chain().focus().undo().run()} title={t('editor.undo')}>
            <Undo size={14} />
          </ToolBtn>
          <ToolBtn onClick={() => editor.chain().focus().redo().run()} title={t('editor.redo')}>
            <Redo size={14} />
          </ToolBtn>
        </div>
      )}

      <EditorContent editor={editor} className="tiptap-editor" />
      {allowImageUpload && <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />}
    </div>
  );
};

export default RichTextEditor;
