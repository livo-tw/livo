import { act,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { User } from '@/types';
import type { KnowledgeRule,KnowledgePage } from '@/types/knowledge';
import type { ImportPolicy } from '@/types/knowledgeImport';
import KnowledgeImportPermissions from '@/components/KnowledgeImportPermissions';
import KnowledgeImportDialog from '@/components/KnowledgeImportDialog';
import KnowledgeImportSources from '@/components/KnowledgeImportSources';
import { knowledgeImportRequest } from '@/lib/knowledgeImportClient';
vi.mock('@/lib/knowledgeImportClient',()=>({knowledgeImportRequest:vi.fn(),fileBase64:vi.fn(async()=>'IyBUZXN0'),downloadImportPreview:vi.fn()}));
vi.mock('@/hooks/useKnowledgeImportCapability',()=>({useKnowledgeImportCapability:()=>({allowed:true,loading:false,can_manage:false,notion_available:false,processor_configured:true})}));
vi.mock('@/context/AuthContext',()=>({useAuthContext:()=>({currentMemberId:'person',currentMember:{id:'person',role:'member',jobTitle:'PM',isActive:true}})}));
vi.mock('@/context/MemberContext',()=>({useMemberContext:()=>({users:[] as User[]})}));
vi.mock('@/context/ProjectContext',()=>({useProjectContext:()=>({allProjects:[] as never[],productLines:[] as never[]})}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(_key:string,options?:{defaultValue?:string})=>options?.defaultValue||_key,i18n:{language:'en'}})}));
const user=(role:User['role']='member',jobTitle='Engineer'):User=>({id:'person',name:'Example Person',role,jobTitle,isActive:true,email:'example@example.com',avatar:'',color:'',sortOrder:0});
const policy:ImportPolicy&{notion_configured:boolean}={version:1,subjects:{roles:['super_admin'],positions:[],member_ids:[]},notion_subjects:{roles:['super_admin'],positions:[],member_ids:[]},notion_pages:[],notion_configured:false};
beforeEach(()=>{vi.clearAllMocks();vi.mocked(knowledgeImportRequest).mockImplementation(async action=>action==='policy'?policy:[]);});
describe('knowledge import access and recovery UI',()=>{
  it('gives a retry control after policy load fails instead of an endless spinner',async()=>{vi.mocked(knowledgeImportRequest).mockRejectedValueOnce(new Error('network'));render(<KnowledgeImportPermissions actor={user('super_admin')} users={[]}/>);const retry=await screen.findByRole('button',{name:'Try again'});expect(screen.queryByRole('status')).toBeNull();fireEvent.click(retry);await screen.findByRole('button',{name:'Save permissions'});expect(screen.queryByRole('alert')).toBeNull();});
  it('does not offer import-policy or Notion-token configuration to ordinary admins',()=>{render(<KnowledgeImportPermissions actor={user('admin')} users={[]}/>);expect(screen.queryByRole('button',{name:'Save permissions'})).toBeNull();expect(screen.queryByLabelText('New integration token (server-encrypted)')).toBeNull();expect(knowledgeImportRequest).not.toHaveBeenCalled();});
  it('omits unreadable PM destination titles instead of showing disabled private options',async()=>{const rule:KnowledgeRule={roles:[],positions:['PM'],member_ids:[]};const base:Omit<KnowledgePage,'id'|'title'|'access_policy'>={body:'',project_id:null,parent_id:null,sort_order:0,is_archived:false,admin_only:false,created_by:'person',updated_by:'person',created_at:'2026-01-01',updated_at:'2026-01-01',version:1};
    vi.mocked(knowledgeImportRequest).mockImplementation(async action=>action==='list'?[]:action==='start'?{id:'job',source:'md',status:'preview_ready',version:2,policy_version:1,items:[{id:'item',title:'Imported note',status:'ready',original:{size:10},parsed:{body:'<p>Text</p>',warnings:[],pages:[],incomplete:false}}]}:[]);
    render(<KnowledgeImportDialog open onOpenChange={vi.fn()} pages={[{...base,id:'private',title:'Invisible PM title',access_policy:{mode:'custom',view:rule,edit:rule,comment:rule}},{...base,id:'visible',title:'Public guide',access_policy:{mode:'inherit'}}]} users={[]} actor={user()} onImported={vi.fn()}/>);
    await waitFor(()=>expect(screen.getByRole('button',{name:'Markdown .md'})).not.toBeDisabled());fireEvent.click(screen.getByRole('button',{name:'Markdown .md'}));fireEvent.change(screen.getByLabelText('Choose a file'),{target:{files:[new File(['# Test'],'test.md',{type:'text/markdown'})]}});fireEvent.click(screen.getByRole('button',{name:'Upload and parse privately'}));await screen.findByText('Imported note');fireEvent.click(screen.getByLabelText('I reviewed the converted text and all warnings.'));fireEvent.click(screen.getByRole('button',{name:'Continue'}));await waitFor(()=>expect(screen.getByRole('option',{name:'Public guide'})).toBeInTheDocument());expect(screen.queryByRole('option',{name:/Invisible PM title/})).toBeNull();
  });
  it('does not restore private source text when an older request finishes after permission was revoked',async()=>{
    let resolveOld!:(value:unknown)=>void;let rejectNew!:(error:Error)=>void;
    vi.mocked(knowledgeImportRequest).mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{rejectNew=reject;}));
    render(<KnowledgeImportSources pageId="private"/>);fireEvent.focus(window);
    await act(async()=>{rejectNew(new Error('import_forbidden'));});
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await act(async()=>{resolveOld([{id:'secret',version:1,body:'<p>Private source text</p>',original:{name:'Secret source.docx'},assets:[]}]);});
    expect(screen.queryByText('Private source text')).toBeNull();expect(screen.queryByText(/Secret source/)).toBeNull();
  });

});
