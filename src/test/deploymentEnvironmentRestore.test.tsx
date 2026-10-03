import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import AdminBackupSection from '../components/system-admin/AdminBackupSection';
import { missingRestoreEnvironments } from '../lib/deploymentEnvironments';
const mocks=vi.hoisted(()=>({remove:vi.fn(),upsert:vi.fn(),error:vi.fn(),isMock:true,planningRows:[] as {id:string}[],workRows:{} as Record<string,unknown>}));
vi.mock('@/components/ConfirmDialog',()=>({useConfirmDialog:()=>({confirm:async()=>true,ConfirmDialog:():null=>null})}));
vi.mock('@/components/UpgradePrompt',()=>({default:():null=>null}));
vi.mock('sonner',()=>({toast:{error:mocks.error,success:vi.fn(),info:vi.fn()}}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string,values?:{values:string})=>values?`${key}: ${values.values}`:key})}));
vi.mock('@/integrations/supabase/client',()=>({get USING_MOCK_BACKEND(){return mocks.isMock;},supabase:{functions:{invoke:async():Promise<{data:{available:boolean};error:unknown}>=>({data:{available:true},error:null})},from:(table:string)=>{
  const q={select:()=>q,eq:()=>q,or:()=>q,order:()=>q,limit:()=>Promise.resolve({data:Object.prototype.hasOwnProperty.call(mocks.workRows,table)?mocks.workRows[table]:(table==='task_reminder_preferences'?mocks.planningRows:[]),error:null}),
    maybeSingle:()=>Promise.resolve({data:table==='system_settings'?{value:{version:1,values:['Prod']}}:null,error:null}),
    delete:()=>{mocks.remove(table);return q;},upsert:()=>{mocks.upsert(table);return q;},neq:()=>q,then:(resolve: (value: {data:never[];error:null})=>unknown)=>resolve({data:[],error:null})};return q;
}}}));
afterEach(()=>{cleanup();vi.clearAllMocks();mocks.isMock=true;mocks.planningRows=[];mocks.workRows={};vi.restoreAllMocks();});
describe('Deployment environment restore preflight',()=>{
  it.each([null, {}])('rejects a malformed live history response before any deletion',async data=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    mocks.workRows.task_work_events=data;
    const {container}=render(<AdminBackupSection currentMemberId="admin" hasFeature={()=>true} backupSettings={null} setBackupSettings={()=>{}} saveBackupSettings={async()=>{}}/>);
    fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[{text:async()=>JSON.stringify({tasks:[],members:[],projects:[],statuses:[],sprints:[],product_lines:[]})}]}});
    await waitFor(()=>expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('taskWork.errors.work_unavailable')));
    expect(mocks.remove).not.toHaveBeenCalled();expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it.each(['task_work_events','task_work_receipts','tasks','task_checks','task_todos'])('rejects live %s history before any deletion',async table=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    mocks.workRows[table]=[{id:'protected-row'}];
    const {container}=render(<AdminBackupSection currentMemberId="admin" hasFeature={()=>true} backupSettings={null} setBackupSettings={()=>{}} saveBackupSettings={async()=>{}}/>);
    fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[{text:async()=>JSON.stringify({tasks:[],members:[],projects:[],statuses:[],sprints:[],product_lines:[]})}]}});
    await waitFor(()=>expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('taskWork.restoreWorkData')));
    expect(mocks.remove).not.toHaveBeenCalled();expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it.each(['real','backup','live'])('preserves planning records by rejecting %s JSON replacement before deletion',async mode=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    mocks.isMock=mode!=='real';
    if(mode==='live') mocks.planningRows=[{id:'personal-preference'}];
    const {container}=render(<AdminBackupSection currentMemberId="admin" hasFeature={()=>true} backupSettings={null} setBackupSettings={()=>{}} saveBackupSettings={async()=>{}}/>);
    const backup:Record<string,unknown[]>={tasks:[],members:[],projects:[],statuses:[],sprints:[],product_lines:[]};
    if(mode==='backup') backup.task_deadline_history=[{id:'history'}];
    fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[{text:async()=>JSON.stringify(backup)}]}});
    await waitFor(()=>expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining(mode==='real'?'approvalCommand.serverRestore':'taskPlanning.restorePlanningData')));
    expect(mocks.remove).not.toHaveBeenCalled();expect(mocks.upsert).not.toHaveBeenCalled();
  });
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
