import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster, toast } from 'sonner';
import type { TFunction } from 'i18next';
import { showTaskCreatedToast } from '@/lib/taskCreatedToast';
import { appDeepLinkSearch, taskDeepLinkUrl } from '@/lib/appDeepLink';

const translate = ((key: string) => key) as TFunction;
const savedTask = { id: 'saved-task-id', taskKey: 'EX-99' };
const execCopy = vi.fn<() => boolean>();
let previousUrl: string;

beforeEach(() => {
  previousUrl = window.location.href;
  vi.stubEnv('BASE_URL', '/');
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCopy });
  execCopy.mockReset().mockReturnValue(true);
});

afterEach(async () => {
  act(() => { toast.dismiss(); });
  // Sonner finishes its exit animation before removing the toast subscription.
  await waitFor(() => expect(document.querySelector('[data-sonner-toast]')).not.toBeInTheDocument());
  cleanup();
  window.history.replaceState({}, '', previousUrl);
  vi.unstubAllEnvs();
});

async function notifyCreated() {
  render(<Toaster />);
  act(() => { showTaskCreatedToast(savedTask, translate); });
  await screen.findByRole('link', { name: 'task.viewCreatedTask EX-99' });
}

describe('created task links', () => {
  it.each(['/', '/demo/'])('opens the saved ID under the %s app base, without stale parameters', async base => {
    vi.stubEnv('BASE_URL', base);
    window.history.replaceState({}, '', '/?task=old-task&token=stale#old-section');
    await notifyCreated();

    const link = screen.getByRole('link', { name: 'task.viewCreatedTask EX-99' });
    const url = new URL(link.getAttribute('href')!);
    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe(base);
    expect(url.search).toBe('?task=saved-task-id');
    expect(url.hash).toBe('');
    expect(appDeepLinkSearch(url.search)).toBe('?task=saved-task-id');
  });

  it('encodes the task identifier as a single deep-link parameter', () => {
    const id = 'saved id&task=other';
    const url = new URL(taskDeepLinkUrl(id));
    expect([...url.searchParams]).toEqual([['task', id]]);
  });

  it('copies through the HTTP fallback and keeps the view link available', async () => {
    let copied = '';
    execCopy.mockImplementation(() => {
      copied = document.querySelector('textarea')?.value ?? '';
      return true;
    });
    await notifyCreated();
    fireEvent.click(screen.getByRole('button', { name: 'task.copyLink' }));

    await waitFor(() => expect(screen.getByText('task.linkCopied')).toBeInTheDocument());
    expect(execCopy).toHaveBeenCalledWith('copy');
    expect(copied).toBe(`${window.location.origin}/?task=saved-task-id`);
    expect(screen.getByRole('link', { name: 'task.viewCreatedTask EX-99' })).toBeInTheDocument();
  });

  it('shows a manually copyable URL when the HTTP fallback is refused', async () => {
    execCopy.mockReturnValue(false);
    await notifyCreated();
    fireEvent.click(screen.getByRole('button', { name: 'task.copyLink' }));

    await waitFor(() => expect(screen.getByText('common.copyFailed')).toBeInTheDocument());
    expect(screen.getByText(`${window.location.origin}/?task=saved-task-id`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'task.viewCreatedTask EX-99' })).toBeInTheDocument();
  });
});
