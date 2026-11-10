import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommentAttachmentPicker, { type CommentDraftAttachment } from '@/components/comments/CommentAttachmentPicker';
import CommentAttachmentList from '@/components/comments/CommentAttachmentList';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { name?: string }) => values?.name ? `${key} ${values.name}` : key }) }));
const createUrl = vi.fn((_blob: Blob) => 'blob:comment-test');
const revokeUrl = vi.fn();
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
});
afterEach(() => {
  cleanup();
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate); else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke); else Reflect.deleteProperty(URL, 'revokeObjectURL');
});
const image = (name = 'example.png') => new File(['example'], name, { type: 'image/png', lastModified: 1 });
const item = { id: 'example-attachment', fileName: 'example.png', mimeType: 'image/png', size: 7 };

describe('comment attachment selection', () => {
  it('accepts several files and ignores an already selected file', () => {
    const selected = image('selected.png'), added = image('new.png');
    const files: CommentDraftAttachment[] = [{ id: 'selected', file: selected, status: 'complete', progress: 100 }];
    const onFiles = vi.fn();
    render(<CommentAttachmentPicker files={files} onFiles={onFiles} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('commentAttachments.add', { selector: 'input' }), { target: { files: [selected, added, new File(['video'], 'example.mp4', { type: 'video/mp4' })] } });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0].map((file: File) => file.name)).toEqual(['new.png', 'example.mp4']);
  });

  it('reports files beyond the comment limit and never queues them', () => {
    const files: CommentDraftAttachment[] = Array.from({ length: 10 }, (_, index) => ({ id: `example-${index}`, file: image(`${index}.png`), status: 'complete', progress: 100 }));
    const onFiles = vi.fn();
    render(<CommentAttachmentPicker files={files} onFiles={onFiles} onRemove={vi.fn()} />);
    fireEvent.drop(screen.getByText('commentAttachments.drop').closest('button')!, { dataTransfer: { files: [image('extra.png')] } });
    expect(onFiles).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('extra.png: commentAttachments.countLimit');
  });

  it('lets an uploaded draft be removed before publishing and blocks selection while busy', () => {
    const onRemove = vi.fn(), onFiles = vi.fn();
    const files: CommentDraftAttachment[] = [{ id: 'pending-comment', file: image(), status: 'complete', progress: 100 }];
    const view = render(<CommentAttachmentPicker files={files} onFiles={onFiles} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: 'commentAttachments.remove example.png' }));
    expect(onRemove).toHaveBeenCalledWith('pending-comment');
    view.rerender(<CommentAttachmentPicker files={files} busy onFiles={onFiles} onRemove={onRemove} />);
    fireEvent.drop(screen.getByText('commentAttachments.drop').closest('button')!, { dataTransfer: { files: [image('other.png')] } });
    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe('authenticated comment attachment display', () => {
  it('downloads only on request, then previews a matching image and releases its URL', async () => {
    const download = vi.fn(async (_id: string, _signal: AbortSignal) => new Blob(['image'], { type: 'image/png' }));
    render(<CommentAttachmentList attachments={[item]} download={download} scopeKey="example-task:example-member" onError={vi.fn()} />);
    expect(download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'commentAttachments.view' }));
    expect(await screen.findByAltText('example.png')).toHaveAttribute('src', 'blob:comment-test');
    expect(download.mock.calls[0][0]).toBe(item.id);
    fireEvent.click(screen.getByRole('button', { name: 'commentAttachments.closePreview' }));
    await waitFor(() => expect(revokeUrl).toHaveBeenCalledWith('blob:comment-test'));
  });

  it.each(['text/html', 'image/svg+xml'])('never embeds an active %s document even when named as an image', async type => {
    const download = vi.fn(async () => new Blob(['<svg onload="alert(1)"/>'], { type }));
    const view = render(<CommentAttachmentList attachments={[item]} download={download} scopeKey="example-bug:example-member" onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'commentAttachments.view' }));
    expect(await screen.findByRole('link', { name: 'commentAttachments.download' })).toHaveAttribute('download', 'example.png');
    expect(view.container.querySelector('img,video,iframe,object')).toBeNull();
  });

  it('offers controlled video playback for matching supported media', async () => {
    const file = { ...item, fileName: 'example.mp4', mimeType: 'video/mp4' };
    const view = render(<CommentAttachmentList attachments={[file]} download={async () => new Blob(['video'], { type: 'video/mp4' })} scopeKey="example-bug:example-member" onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'commentAttachments.view' }));
    await waitFor(() => expect(view.container.querySelector('video')).toHaveAttribute('controls'));
    expect(view.container.querySelector('video')).not.toHaveAttribute('autoplay');
  });

  it('discards a delayed download after switching record or identity', async () => {
    let finish!: (blob: Blob) => void;
    const pending = new Promise<Blob>(resolve => { finish = resolve; });
    const download = vi.fn((_id: string, _signal: AbortSignal) => pending);
    const view = render(<CommentAttachmentList attachments={[item]} download={download} scopeKey="example-bug:alex" onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'commentAttachments.view' }));
    view.rerender(<CommentAttachmentList attachments={[item]} download={download} scopeKey="other-bug:morgan" onError={vi.fn()} />);
    expect(download.mock.calls[0][1].aborted).toBe(true);
    await act(async () => { finish(new Blob(['image'], { type: 'image/png' })); await pending; });
    expect(createUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'commentAttachments.download' })).toBeNull();
  });

  it('shows a denied download through the caller without creating a preview', async () => {
    const failure = new Error('forbidden'), onError = vi.fn();
    render(<CommentAttachmentList attachments={[item]} download={async () => { throw failure; }} scopeKey="example-bug:example-member" onError={onError} />);
    fireEvent.click(screen.getByRole('button', { name: 'commentAttachments.view' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(createUrl).not.toHaveBeenCalled();
  });
});
