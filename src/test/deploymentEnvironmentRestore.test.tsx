import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import AdminBackupSection from '../components/system-admin/AdminBackupSection';
import { missingRestoreEnvironments } from '../lib/deploymentEnvironments';
const mocks=vi.hoisted(()=>({remove:vi.fn(),upsert:vi.fn(),error:vi.fn()}));
vi.mock('@/components/ConfirmDialog',()=>({useConfirmDialog:()=>({confirm:async()=>true,ConfirmDialog:():null=>null})}));
vi.mock('@/components/UpgradePrompt',()=>({default:():null=>null}));
vi.mock('sonner',()=>({toast:{error:mocks.error,success:vi.fn(),info:vi.fn()}}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string,values?:{values:string})=>values?`${key}: ${values.values}`:key})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:(table:string)=>{
  const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>Promise.resolve({data:[],error:null}),
    maybeSingle:()=>Promise.resolve({data:table==='system_settings'?{value:{version:1,values:['Prod']}}:null,error:null}),
    delete:()=>{mocks.remove(table);return q;},upsert:()=>{mocks.upsert(table);return q;},neq:()=>Promise.resolve({data:[],error:null})};return q;
}}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('Deployment environment restore preflight',()=>{
  it('lists missing historical environments without accepting settings from the backup',()=>{
    expect(missingRestoreEnvironments([{environment:'Production'},{environment:'Prod'},{environment:'Production'}],['Prod'])).toEqual(['Production']);
    expect(()=>missingRestoreEnvironments([{environment:3}],['Prod'])).toThrow('invalid-deployment-backup');
  });
  it('rejects a backup before any destructive operation when an environment is unavailable',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const {container}=render(<AdminBackupSection currentMemberId="admin" hasFeature={()=>true} backupSettings={null} setBackupSettings={()=>{}} saveBackupSettings={async()=>{}}/>);
    const backup:Record<string,unknown[]>={tasks:[],members:[],projects:[],statuses:[],sprints:[],product_lines:[],task_deployments:[{environment:'Production'}],system_settings:[{key:'deployment_environments',value:{version:1,values:['Production']}}]};
    fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[{text:async()=>JSON.stringify(backup)}]}});
    await waitFor(()=>expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('deploymentEnvironments.restoreMissing: Production')));
    expect(mocks.remove).not.toHaveBeenCalled();expect(mocks.upsert).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
