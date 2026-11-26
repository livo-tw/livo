import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RichTextEditor from '@/components/RichTextEditor';

afterEach(cleanup);

describe('RichTextEditor', () => {
  it('mounts the default editable editor used in the new task form', () => {
    render(<RichTextEditor content="<p>Task description</p>" onChange={vi.fn()} />);

    expect(screen.getByText('Task description').closest('[contenteditable]'))
      .toHaveAttribute('contenteditable', 'true');
  });

  it('exposes the compact comment editor as a named multiline textbox', () => {
    render(<RichTextEditor compact content="<p>Draft comment</p>" onChange={vi.fn()} placeholder="Leave a comment" />);

    const editor = screen.getByRole('textbox', { name: 'Leave a comment' });
    expect(editor).toHaveAttribute('aria-multiline', 'true');
    expect(editor).toHaveTextContent('Draft comment');
  });
});
