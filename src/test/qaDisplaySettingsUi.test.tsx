import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { QaClient } from '@/lib/qa/client';
import { defaultQaDisplaySettings } from '@/lib/qa/displaySettings';
import { DEFAULT_QA_WORKFLOW } from '@/lib/qa/workflow';
import { QaDisplaySettingsContext } from '@/context/QaDisplaySettingsContext';
import { useQaDisplaySettings } from '@/hooks/useQaDisplaySettings';
import QaDisplaySettings from '@/components/qa/QaDisplaySettings';
import QaDisplaySettingsNotice from '@/components/qa/QaDisplaySettingsNotice';
import { QaSeverityBadge } from '@/components/qa/QaBadges';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));
afterEach(cleanup);
function Probe({ client }: { client: Pick<QaClient, 'getDisplaySettings'> }) {
  const loaded = useQaDisplaySettings(client);
  return <><QaDisplaySettingsNotice {...loaded} /><output>{loaded.configuration ? String(loaded.configuration.showSeverity) : 'unknown'}</output></>;
}
describe('QA display configuration reads and saves', () => {
  it('keeps failed reads unknown and supports retry', async () => {
    const getDisplaySettings = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(defaultQaDisplaySettings());
    render(<Probe client={{ getDisplaySettings }} />);
    await screen.findByRole('alert');
    expect(screen.getByText('unknown')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'qa.retry' }));
    await screen.findByText('true');
    expect(getDisplaySettings).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed successful replies as unknown', async () => {
    render(<Probe client={{ getDisplaySettings: vi.fn().mockResolvedValue({}) }} />);
    await screen.findByRole('alert');
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });
  it('cannot fill a switched client with a previous workspace response', async () => {
    let resolve: (value: unknown) => void = () => {};
    const previous = { getDisplaySettings: vi.fn(() => new Promise(resolveValue => { resolve = resolveValue; })) } as Pick<QaClient, 'getDisplaySettings'>;
    const current = { getDisplaySettings: vi.fn().mockResolvedValue({ ...defaultQaDisplaySettings(), showSeverity: false }) };
    const view = render(<Probe client={previous} />);
    await waitFor(() => expect(previous.getDisplaySettings).toHaveBeenCalled());
    view.rerender(<Probe client={current} />); await screen.findByText('false');
    resolve(defaultQaDisplaySettings());
    await waitFor(() => expect(screen.getByText('false')).toBeInTheDocument());
  });
  it('hides severity badges without changing their stored value', () => {
    const configuration = { ...defaultQaDisplaySettings(), showSeverity: false };
    render(<QaDisplaySettingsContext.Provider value={configuration}><QaSeverityBadge severity="high" /></QaDisplaySettingsContext.Provider>);
    expect(screen.queryByText(/qa.severity/)).not.toBeInTheDocument();
    expect(configuration.showSeverity).toBe(false);
  });
  it.each(['member', 'admin'] as const)('does not expose controls to %s with QA capability', role => {
    const client = { getDisplaySettings: vi.fn().mockResolvedValue(defaultQaDisplaySettings()) } as unknown as QaClient;
    render(<QaDisplaySettings client={client} actor={{ id: 'example-actor', role, qaAdmin: true }} workflow={DEFAULT_QA_WORKFLOW} onClose={vi.fn()} />);
    expect(screen.getByText('qa.displaySettings.forbidden')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
  it('saves a canonical snapshot and reads it back before reporting success', async () => {
    const configuration = defaultQaDisplaySettings(), updated = { ...configuration, showSeverity: false };
    const getDisplaySettings = vi.fn().mockResolvedValueOnce(configuration).mockResolvedValueOnce(updated);
    const saveDisplaySettings = vi.fn().mockResolvedValue(updated);
    render(<QaDisplaySettings client={{ getDisplaySettings, saveDisplaySettings } as unknown as QaClient} actor={{ id: 'example-actor', role: 'super_admin' }} workflow={DEFAULT_QA_WORKFLOW} onClose={vi.fn()} />);
    const checkbox = await screen.findByLabelText('qa.displaySettings.showSeverity');
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    fireEvent.click(checkbox); fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    await waitFor(() => expect(saveDisplaySettings).toHaveBeenCalledWith(updated));
    await waitFor(() => expect(getDisplaySettings).toHaveBeenCalledTimes(2));
  });
  it('blocks invalid all-hidden choices before any save', async () => {
    const saveDisplaySettings = vi.fn();
    const client = { getDisplaySettings: vi.fn().mockResolvedValue(defaultQaDisplaySettings()), saveDisplaySettings } as unknown as QaClient;
    render(<QaDisplaySettings client={client} actor={{ id: 'example-actor', role: 'super_admin' }} workflow={DEFAULT_QA_WORKFLOW} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('qa.displaySettings.showSeverity')).not.toBeDisabled());
    for (const label of ['highest', 'high', 'medium', 'low', 'lowest']) fireEvent.click(screen.getByLabelText('priority.' + label));
    fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    await screen.findByRole('alert');
    expect(saveDisplaySettings).not.toHaveBeenCalled();
  });
});
