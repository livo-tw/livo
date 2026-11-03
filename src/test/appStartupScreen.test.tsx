import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppStartupScreen } from '@/components/AppStartupScreen';

vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
afterEach(cleanup);

describe('application startup state', () => {
  it('distinguishes identity verification from still-loading application data', () => {
    const view = render(<AppStartupScreen memberVerified={false} isLoading loadFailed={false} onRetry={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toBe('common.verifyingIdentity');
    view.rerender(<AppStartupScreen memberVerified isLoading loadFailed={false} onRetry={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toBe('common.loading');
  });

  it.each([false, true])('exposes a retry for failed reads even when memberVerified=%s', memberVerified => {
    const retry = vi.fn();
    render(<AppStartupScreen memberVerified={memberVerified} isLoading={false} loadFailed onRetry={retry} />);
    expect(screen.getByRole('alert').textContent).toContain('common.loadFailed');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not render a placeholder after identity and application data are ready', () => {
    const { container } = render(<AppStartupScreen memberVerified isLoading={false} loadFailed={false} onRetry={vi.fn()} />);
    expect(container.textContent).toBe('');
  });
});
