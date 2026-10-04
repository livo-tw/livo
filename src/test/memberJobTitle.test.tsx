import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMemberManage } from '@/components/member-manage/useMemberManage';
import MemberTableDesktop from '@/components/member-manage/MemberTableDesktop';
import MemberCardsMobile from '@/components/member-manage/MemberCardsMobile';
import EditJobTitleModal from '@/components/member-manage/EditJobTitleModal';
import AddMemberModal from '@/components/member-manage/AddMemberModal';
import zhTW from '@/i18n/locales/zh-TW.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import en from '@/i18n/locales/en.json';

const state = vi.hoisted(() => ({
  role: 'super_admin',
  users: [
    { id:'self',name:'Alex',avatar:'A',color:'#0065FF',role:'super_admin',jobTitle:'Lead',isActive:true,email:'alex@example.com' },
    { id:'other',name:'Morgan',avatar:'M',color:'#0065FF',role:'member',jobTitle:'Engineer',isActive:false,email:'morgan@example.com' },
  ],
  refresh: vi.fn(), acquire: vi.fn(), release: vi.fn(), update: vi.fn(), eq: vi.fn(), success: vi.fn(), error: vi.fn(), invoke: vi.fn(),
  result: { data:{id:'other'} as {id:string}|null, error:null as {message:string}|null },
}));
vi.mock('@/context/MemberContext',()=>({useMemberContext:()=>({users:state.users,refreshUsers:state.refresh})}));
vi.mock('@/context/TaskContext',()=>({useTaskContext:()=>({allTasks:[] as never[],comments:[] as never[],statuses:[] as never[]})}));
vi.mock('@/context/AuthContext',()=>({useAuthContext:()=>({permissions:{},currentMemberId:'self',currentMember:{id:'self',role:state.role}})}));
vi.mock('@/context/LicenseContext',()=>({useLicense:()=>({hasFeature:()=>true})}));
vi.mock('@/hooks/usePresenceLock',()=>({usePresenceLock:()=>({viewers:[] as never[],acquireLock:state.acquire,releaseLock:state.release,isLockedBy:():{name:string}|null=>null})}));
vi.mock('@/components/ConfirmDialog',()=>({useConfirmDialog:()=>({confirm:vi.fn(),ConfirmDialog:null as React.ReactNode})}));
vi.mock('@/lib/activityLog',()=>({logActivity:vi.fn()}));
vi.mock('@/lib/department',()=>({sortUsersByDept:(users:unknown[])=>users}));
vi.mock('@/i18n',()=>({default:{t:(key:string)=>key}}));
vi.mock('sonner',()=>({toast:{success:state.success,error:state.error}}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{
  functions:{invoke:state.invoke},
  from:(table:string)=>table==='activity_logs'
    ? {select:()=>({order:()=>({limit:async()=>({data:[] as never[]})})})}
    : {update:(patch:unknown)=>{
        state.update(patch);
        return {eq:(...args:unknown[])=>{
          state.eq(...args);
          return {select:()=>({maybeSingle:async()=>state.result})};
        }};
      }},
}}));

beforeEach(()=>{vi.clearAllMocks();state.role='super_admin';state.acquire.mockResolvedValue({acquired:true});state.result={data:{id:'other'},error:null};});
afterEach(cleanup);
const submit={preventDefault:vi.fn()} as unknown as React.FormEvent;

describe('editing member job titles',()=>{
  it.each(['self','other'])('saves any custom title for %s, including self and inactive members',async id=>{
    const {result}=renderHook(()=>useMemberManage());
    act(()=>result.current.openEditJobTitle(id));
    act(()=>result.current.setEditJobTitle('  Custom Product Lead  '));
    await act(async()=>{await result.current.handleSaveJobTitle(submit);});
    expect(state.acquire).toHaveBeenCalledWith(`member-${id}`);
    expect(state.update).toHaveBeenCalledWith({job_title:'Custom Product Lead'});
    expect(state.eq).toHaveBeenCalledWith('id',id);
    expect(state.refresh).toHaveBeenCalledOnce();
    expect(state.release).toHaveBeenCalledWith(`member-${id}`);
    expect(result.current.jobTitleTarget).toBeNull();
  });
  it.each(['admin','member'])('does not let %s start editing or issue a write',async role=>{
    state.role=role;
    const {result}=renderHook(()=>useMemberManage());
    act(()=>result.current.openEditJobTitle('other'));
    await act(async()=>{await result.current.handleSaveJobTitle(submit);});
    expect(result.current.jobTitleTarget).toBeNull();
    expect(state.update).not.toHaveBeenCalled();
  });
  it('keeps the dialog open on backend denial and releases the lock',async()=>{
    state.result={data:null,error:{message:'permission denied'}};
    const {result}=renderHook(()=>useMemberManage());
    act(()=>result.current.openEditJobTitle('other'));
    await act(async()=>{await result.current.handleSaveJobTitle(submit);});
    expect(result.current.jobTitleError).toContain('permission denied');
    expect(result.current.jobTitleTarget?.id).toBe('other');
    expect(state.success).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledWith('member-other');
  });
  it('does not report success when the target row is no longer writable',async()=>{
    state.result={data:null,error:null};
    const {result}=renderHook(()=>useMemberManage());
    act(()=>result.current.openEditJobTitle('other'));
    await act(async()=>{await result.current.handleSaveJobTitle(submit);});
    expect(result.current.jobTitleError).toContain('memberJobTitle.saveFailed');
    expect(state.success).not.toHaveBeenCalled();
  });
  it('honors another member’s lock without changing the title',async()=>{
    state.acquire.mockResolvedValue({acquired:false,lockerName:'Reviewer'});
    const {result}=renderHook(()=>useMemberManage());
    act(()=>result.current.openEditJobTitle('other'));
    await act(async()=>{await result.current.handleSaveJobTitle(submit);});
    expect(state.update).not.toHaveBeenCalled();
    expect(state.release).not.toHaveBeenCalled();
    expect(result.current.jobTitleError).toBe('member.lockedByOther');
  });
  it('allows clearing a title but rejects values longer than 200 characters',async()=>{
    const {result}=renderHook(()=>useMemberManage());
    act(()=>result.current.openEditJobTitle('other'));
    act(()=>result.current.setEditJobTitle('x'.repeat(201)));
    await act(async()=>{await result.current.handleSaveJobTitle(submit);});
    expect(state.update).not.toHaveBeenCalled();
    act(()=>result.current.setEditJobTitle('  '));
    await act(async()=>{await result.current.handleSaveJobTitle(submit);});
    expect(state.update).toHaveBeenCalledWith({job_title:''});
  });
});

async function translation(lang='zh-TW') {
 const i18n=createInstance();await i18n.init({lng:lang,fallbackLng:false,resources:{'zh-TW':{translation:zhTW},'zh-CN':{translation:zhCN},en:{translation:en}},interpolation:{escapeValue:false}});return i18n;
}
function tableProps(superAdmin=true): React.ComponentProps<typeof MemberCardsMobile> & {onEditJobTitle: ReturnType<typeof vi.fn>} {
 return {memberStats:state.users.map(user=>({user,assignedCount:0,completedCount:0,commentCount:0,lastActivity:null as Date|null})),currentMemberId:'self',isSuperAdmin:superAdmin,canReorder:false,dragIndex:null,dragOverIndex:null,actionLoading:null,isLockedBy:()=>null,formatDate:()=>'',onDragStart:vi.fn(),onDragOver:vi.fn(),onDragEnd:vi.fn(),onTouchStart:vi.fn(),onTouchMove:vi.fn(),onTouchEnd:vi.fn(),onRoleChange:vi.fn(),onToggleActive:vi.fn(),onDelete:vi.fn(),onResetPassword:vi.fn(),onCreateLogin:vi.fn(),onEditJobTitle:vi.fn()};
}
describe('member title entry points',()=>{
 it.each([MemberTableDesktop,MemberCardsMobile])('offers the super administrator an editor for every row',async Component=>{
   const props=tableProps();const i18n=await translation();
   render(<I18nextProvider i18n={i18n}><Component {...props}/></I18nextProvider>);
   fireEvent.click(screen.getByRole('button',{name:'編輯 Alex 的職位'}));
   fireEvent.click(screen.getByRole('button',{name:'編輯 Morgan 的職位'}));
   expect(props.onEditJobTitle.mock.calls).toEqual([['self'],['other']]);
 });
 it.each([MemberTableDesktop,MemberCardsMobile])('hides editing from other roles',async Component=>{
   const i18n=await translation();render(<I18nextProvider i18n={i18n}><Component {...tableProps(false)}/></I18nextProvider>);
   expect(screen.queryByRole('button',{name:/編輯.*的職位/})).toBeNull();
   expect(screen.queryAllByRole('button')).toHaveLength(0);
 });
 it.each(['zh-TW','zh-CN','en'])('accepts custom titles with translated labels in %s',async lang=>{
   const i18n=await translation(lang);const change=vi.fn();
   render(<I18nextProvider i18n={i18n}><EditJobTitleModal target={{id:'other',name:'Morgan'}} value="Engineer" onChange={change} existingTitles={['PM','Director']} loading={false} error={null} onClose={vi.fn()} onSubmit={vi.fn()}/></I18nextProvider>);
   const input=screen.getByRole('combobox',{name:i18n.t('memberList.jobTitleLabel')});
   fireEvent.change(input,{target:{value:'Custom Product Lead'}});
   expect(change).toHaveBeenCalledWith('Custom Product Lead');
   expect(input.getAttribute('maxlength')).toBe('200');
   expect(screen.getByRole('button',{name:i18n.t('memberJobTitle.save')})).toBeTruthy();
   await waitFor(()=>expect(screen.getByRole('dialog')).toBeTruthy());
 });
 it.each([true,false])('only exposes job-title assignment when super-admin permission is %s',async canEditJobTitle=>{
   const i18n=await translation();
   render(<I18nextProvider i18n={i18n}><AddMemberModal show onClose={vi.fn()} form={{email:'new@example.com',name:'New member',role:'member',jobTitle:'',password:''}} setForm={vi.fn()} jobTitleRef={{current:null}} jobTitleOpen={false} setJobTitleOpen={vi.fn()} filteredJobTitles={['PM']} onSubmit={vi.fn()} loading={false} canEditJobTitle={canEditJobTitle}/></I18nextProvider>);
   expect(!!screen.queryByPlaceholderText(i18n.t('memberList.jobTitlePlaceholder'))).toBe(canEditJobTitle);
   expect(screen.getAllByRole('option')).toHaveLength(canEditJobTitle ? 4 : 1);
 });
});

describe('resetting a member password',()=>{
  const reset=async()=>{
    const {result}=renderHook(()=>useMemberManage());
    act(()=>result.current.openResetPassword('other','Morgan'));
    act(()=>result.current.setResetForm({password:'long-password',confirm:'long-password'}));
    await act(async()=>{await result.current.handleResetPassword(submit);});
  };
  it('says so when the login with that email belongs to another member',async()=>{
    // supabase-js answers a non-2xx with data null and the body on error.context.
    state.invoke.mockResolvedValue({data:null,error:Object.assign(new Error('Edge Function returned a non-2xx status code'),
      {context:new Response(JSON.stringify({error:'email_taken',message:'taken'}),{status:409})})});
    await reset();
    expect(state.error).toHaveBeenCalledWith('member.resetPasswordEmailTaken');
  });
  it('shows the server message for other failures',async()=>{
    state.invoke.mockResolvedValue({data:null,error:Object.assign(new Error('Edge Function returned a non-2xx status code'),
      {context:new Response(JSON.stringify({error:'Member not found'}),{status:404})})});
    await reset();
    expect(state.error).toHaveBeenCalledWith('member.resetPasswordFailedMember not found');
  });
});

describe('adding a member',()=>{
  it('says so when the login with that email belongs to another member',async()=>{
    state.invoke.mockResolvedValue({data:null,error:Object.assign(new Error('Edge Function returned a non-2xx status code'),
      {context:new Response(JSON.stringify({error:'email_taken',message:'taken'}),{status:409})})});
    const {result}=renderHook(()=>useMemberManage());
    act(()=>result.current.setAddForm({email:'Boss@example.com',name:'Boss',role:'member',jobTitle:'',password:''}));
    await act(async()=>{await result.current.handleAddMember(submit);});
    expect(state.error).toHaveBeenCalledWith('member.addEmailTaken');
    expect(state.success).not.toHaveBeenCalled();
  });
  it('names a duplicate member in the current language',async()=>{
    state.invoke.mockResolvedValue({data:null,error:Object.assign(new Error('Edge Function returned a non-2xx status code'),
      {context:new Response(JSON.stringify({error:'此 Email 的成員已存在',code:'member_exists'}),{status:400})})});
    const {result}=renderHook(()=>useMemberManage());
    act(()=>result.current.setAddForm({email:'member2@example.com',name:'Dup',role:'member',jobTitle:'',password:''}));
    await act(async()=>{await result.current.handleAddMember(submit);});
    expect(state.error).toHaveBeenCalledWith('member.addDuplicate');
  });
});
