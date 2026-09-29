import { lazy, Suspense, type ComponentProps } from 'react';

// Defers the tiptap editor chunk until an editor is actually rendered
// (modal open) instead of loading it at startup.
const RichTextEditor = lazy(() => import('@/components/RichTextEditor'));

type RichTextEditorProps = ComponentProps<typeof RichTextEditor>;

const RichTextEditorLazy = (props: RichTextEditorProps) => (
  <Suspense fallback={<div className="min-h-[80px]" />}>
    <RichTextEditor {...props} />
  </Suspense>
);

export default RichTextEditorLazy;
