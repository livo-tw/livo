import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { DeploymentEnvironmentProvider, useDeploymentEnvironments } from '../context/DeploymentEnvironmentContext';
const mock = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), filters: vi.fn(), change: null as (()=>void)|null }));
vi.mock('@/context/AuthContext',()=>({useAuthContext:()=>({realMemberId:'member-a',currentMemberId:'member-a'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{
  from:()=>{
    let writing=false;
    const query={select:()=>query,eq:(...args:unknown[])=>{mock.filters(...args);return query;},insert:(value:unknown)=>{writing=true;mock.filters('insert',value);return query;},update:(value:unknown)=>{writing=true;mock.filters('update',value);return query;},maybeSingle:()=>writing?mock.write():mock.read(),single:()=>mock.write()};
    return query;
  },
  channel:()=>{const channel={on:(_event:unknown,_filter:unknown,fn:()=>void)=>{mock.change=fn;return channel;},subscribe:()=>channel};return channel;},removeChannel:vi.fn(),
}}));
let current: ReturnType<typeof useDeploymentEnvironments>;
function Consumer(){current=useDeploymentEnvironments();return <span>{current.values.join('|')}</span>;}
beforeEach(()=>{vi.clearAllMocks();mock.read.mockResolvedValue({data:{value:{version:1,values:['Preview','Production']},updated_at:'revision-1'},error:null});mock.write.mockResolvedValue({data:{updated_at:'revision-2'},error:null});});
afterEach(cleanup);
describe('Deployment environment provider',()=>{
  it('loads shared settings, saves with CAS, and applies realtime catalog changes',async()=>{
    render(<DeploymentEnvironmentProvider><Consumer/></DeploymentEnvironmentProvider>);
    await waitFor(()=>expect(current.ready).toBe(true));
    expect(current.values).toEqual(['Preview','Production']);
    await act(()=>current.save(['Production','Canary'],'revision-1'));
    expect(mock.filters).toHaveBeenCalledWith('updated_at','revision-1');
    expect(current.revision).toBe('revision-2');
    mock.read.mockResolvedValue({data:{value:{version:1,values:['Canary']},updated_at:'revision-3'},error:null});
    await act(async()=>{mock.change?.();});
    expect(current.values).toEqual(['Canary']);
  });
  it('detects a concurrent update and reloads rather than overwriting',async()=>{
    render(<DeploymentEnvironmentProvider><Consumer/></DeploymentEnvironmentProvider>);
    await waitFor(()=>expect(current.ready).toBe(true));
    mock.write.mockResolvedValue({data:null,error:null});
    await act(async()=>{await expect(current.save(['Canary'],'revision-1')).rejects.toThrow('environment-conflict');});
    expect(current.values).toEqual(['Preview','Production']);
    expect(mock.read).toHaveBeenCalledTimes(2);
  });
  it('fails closed on malformed persisted settings and uses defaults only when missing',async()=>{
    mock.read.mockResolvedValue({data:{value:null,updated_at:'bad'},error:null});
    render(<DeploymentEnvironmentProvider><Consumer/></DeploymentEnvironmentProvider>);
    await waitFor(()=>expect(current.loadError).toBe(true));
    expect(current.ready).toBe(false);
    await expect(current.save(['Prod'],'bad')).rejects.toThrow('invalid-environments');
    expect(mock.write).not.toHaveBeenCalled();
    mock.read.mockResolvedValue({data:null,error:null});
    await act(()=>current.reload());
    expect(current.values).toEqual(['Dev','QA','Stage','Live Staging','Prod']);
    await act(()=>current.save(['Preview'],null));
    expect(mock.filters).toHaveBeenCalledWith('insert',expect.objectContaining({key:'deployment_environments',value:{version:1,values:['Preview']}}));
  });
});
