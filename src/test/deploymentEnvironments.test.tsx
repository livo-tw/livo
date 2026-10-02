import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_DEPLOYMENT_ENVIRONMENTS, deploymentEnvironmentOptions, parseDeploymentEnvironments } from '../lib/deploymentEnvironments';
import QaEnvironmentField from '../components/qa/QaEnvironmentField';
import DeploymentEnvironmentSettings from '../components/DeploymentEnvironmentSettings';
import TaskFormDeployment from '../components/create-task/TaskFormDeployment';
const state = vi.hoisted(() => ({ values: ['Canary', 'Production'], revision: 'v1', ready: true, loadError: false, save: vi.fn(async (): Promise<void> => {}), reload: vi.fn(async (): Promise<void> => {}), admin: true }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => state }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ permissions: { canManageStatuses: state.admin } }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: {number: number}) => options ? `${key} ${options.number}` : key }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => { cleanup(); state.admin = true; state.ready = true; state.loadError = false; vi.clearAllMocks(); });
describe('Shared deployment environments', () => {
  it('defaults only when missing and preserves custom order', () => {
    expect(parseDeploymentEnvironments(undefined)?.values).toEqual(DEFAULT_DEPLOYMENT_ENVIRONMENTS);
    expect(parseDeploymentEnvironments({version:1,values:['Canary','Production']})?.values).toEqual(['Canary','Production']);
  });
  it.each([null, {}, {version:2,values:['Prod']}, {version:1,values:[]}, {version:1,values:['QA','QA']}, {version:1,values:[' QA']}, {version:1,values:['QA\n']}, {version:1,values:['a\u007f']}, {version:1,values:['x'.repeat(121)]}, {version:1,values:['QA'],extra:true}, {version:1,values:Array.from({length:31},(_,i)=>`env${i}`)}])('rejects malformed setting %j', value => {
    expect(parseDeploymentEnvironments(value)).toBeNull();
  });
  it('counts Unicode characters consistently with databases', () => {
    expect(parseDeploymentEnvironments({version:1,values:['🚀'.repeat(120)]})).not.toBeNull();
    expect(parseDeploymentEnvironments({version:1,values:['🚀'.repeat(121)]})).toBeNull();
  });
  it('retains historical values without making them selectable', () => {
    expect(deploymentEnvironmentOptions(['QA','Prod'],['Production','QA','x\n'])).toEqual([{value:'QA',legacy:false},{value:'Prod',legacy:false},{value:'Production',legacy:true}]);
    const change = vi.fn(); render(<QaEnvironmentField label="Environment" value="Old Stage" onChange={change} />);
    expect(screen.getByRole('option',{name:'Old Stage (qa.legacyValue)'})).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Environment'),{target:{value:'Production'}});
    expect(change).toHaveBeenCalledWith('Production');
    expect(screen.queryByRole('option',{name:'Stage'})).toBeNull();
  });
  it('blocks selection when settings cannot load', () => {
    state.ready = false; state.loadError = true;
    render(<QaEnvironmentField label="Environment" value="" onChange={vi.fn()} />);
    expect(screen.getByLabelText('Environment')).toBeDisabled();
    expect(screen.getByText('deploymentEnvironments.loadFailed')).toBeVisible();
  });
  it('uses the same custom options for normal cards and lets a draft discard a removed value',()=>{
    const change=vi.fn();
    render(<TaskFormDeployment deployments={[{environment:'Old Stage',status:'scheduled'}]} setDeployments={change} requiredFields={{}}/>);
    expect(screen.getByRole('button',{name:'Canary'})).toBeEnabled();
    expect(screen.queryByRole('button',{name:'Dev'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Old Stage (qa.legacyValue)'}));
    expect(change).toHaveBeenCalled();
    expect(change.mock.calls[0][0]([{environment:'Old Stage',status:'scheduled'}])).toEqual([]);
  });
  it('hides management for members', () => {
    state.admin = false; render(<DeploymentEnvironmentSettings />);
    expect(screen.queryByText('deploymentEnvironments.title')).toBeNull();
  });
  it('saves additions, renames and order against the original revision', async () => {
    render(<DeploymentEnvironmentSettings />);
    fireEvent.change(screen.getByLabelText('deploymentEnvironments.name 1'),{target:{value:'Preview'}});
    fireEvent.click(screen.getAllByLabelText('deploymentEnvironments.moveDown')[0]);
    fireEvent.click(screen.getByText('deploymentEnvironments.add'));
    fireEvent.change(screen.getByLabelText('deploymentEnvironments.name 3'),{target:{value:'QA 2'}});
    fireEvent.click(screen.getByText('deploymentEnvironments.save'));
    await waitFor(() => expect(state.save).toHaveBeenCalledWith(['Production','Preview','QA 2'],'v1'));
  });
  it('removes only catalog entries and rejects duplicates', async () => {
    render(<DeploymentEnvironmentSettings />);
    fireEvent.change(screen.getByLabelText('deploymentEnvironments.name 1'),{target:{value:'Production'}});
    fireEvent.click(screen.getByText('deploymentEnvironments.save'));
    expect(state.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByLabelText('deploymentEnvironments.remove')[0]);
    fireEvent.click(screen.getByText('deploymentEnvironments.save'));
    await waitFor(() => expect(state.save).toHaveBeenCalledWith(['Production'],'v1'));
  });
});
