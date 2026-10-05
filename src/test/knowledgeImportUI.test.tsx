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
const capability=vi.hoisted(()=>({allowed:true,loading:false,can_manage:false,notion_available:false,processor_configured:true}));
vi.mock('@/hooks/useKnowledgeImportCapability',()=>({useKnowledgeImportCapability:()=>capability}));
vi.mock('@/context/AuthContext',()=>({useAuthContext:()=>({currentMemberId:'person',currentMember:{id:'person',role:'member',jobTitle:'PM',isActive:true}})}));
vi.mock('@/context/MemberContext',()=>({useMemberContext:()=>({users:[] as User[]})}));
vi.mock('@/context/ProjectContext',()=>({useProjectContext:()=>({allProjects:[] as never[],productLines:[] as never[]})}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(_key:string,options?:{defaultValue?:string})=>options?.defaultValue||_key,i18n:{language:'en'}})}));
const user=(role:User['role']='member',jobTitle='Engineer'):User=>({id:'person',name:'Example Person',role,jobTitle,isActive:true,email:'example@example.com',avatar:'',color:'',sortOrder:0});
const policy:ImportPolicy&{notion_configured:boolean}={version:1,subjects:{roles:['super_admin'],positions:[],member_ids:[]},notion_subjects:{roles:['super_admin'],positions:[],member_ids:[]},notion_pages:[],notion_configured:false};
beforeEach(()=>{vi.clearAllMocks();capability.processor_configured=true;vi.mocked(knowledgeImportRequest).mockImplementation(async action=>action==='policy'?policy:[]);});
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

  it('retries parsing from partial results, returns to preview and waits for a fresh review',async()=>{
    const good={id:'good',title:'Ready note',status:'ready',original:{size:0},parsed:{body:'<p>Converted note</p>',warnings:[] as string[],pages:[] as never[],incomplete:true}};
    const failed={id:'failed',title:'Failed note',status:'failed',original:{size:0},error:'processing_timeout'};
    const initial={id:'job',source:'md',status:'preview_ready',version:2,items:[good,failed]};
    const partial={...initial,status:'partially_failed',version:4,items:[{...good,status:'committed',page_id:'created'},failed]};
    const parsing={...partial,status:'parsing',version:5,items:[partial.items[0],{...failed,status:'pending',error:undefined}]};
    const recovered={...partial,status:'preview_ready',version:6,items:[partial.items[0],{...good,id:'failed',title:'Recovered note',parsed:{...good.parsed,body:'<p>Newly recovered text</p>',incomplete:false}}]};
    vi.mocked(knowledgeImportRequest).mockImplementation(async action=>action==='list'?[]:action==='start'?initial:action==='preview_target'?{job:initial,previous:[],current:null,duplicates:[]}:action==='commit'?partial:action==='retry'?parsing:action==='get'?recovered:[]);
    render(<KnowledgeImportDialog open onOpenChange={vi.fn()} pages={[]} users={[]} actor={user()} onImported={vi.fn()}/>);
    await waitFor(()=>expect(screen.getByRole('button',{name:'Markdown .md'})).not.toBeDisabled());fireEvent.click(screen.getByRole('button',{name:'Markdown .md'}));fireEvent.change(screen.getByLabelText('Choose a file'),{target:{files:[new File(['# Note'],'note.md')]}});fireEvent.click(screen.getByRole('button',{name:'Upload and parse privately'}));
    await screen.findByText('Converted note');fireEvent.click(screen.getByLabelText('I reviewed the converted text and all warnings.'));fireEvent.click(screen.getByLabelText(/Save the available text and original file/i));fireEvent.click(screen.getByRole('button',{name:'Continue'}));fireEvent.click(screen.getByRole('button',{name:'Check destination and compare'}));fireEvent.click(await screen.findByLabelText('I confirm the destination audience may read this source.'));fireEvent.click(screen.getByRole('button',{name:'Confirm import'}));
    await screen.findByText('Partially completed; inspect each item');expect(screen.queryByRole('button',{name:'Review destination and retry import'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Retry failed items / OCR pages'}));
    await waitFor(()=>expect(knowledgeImportRequest).toHaveBeenCalledWith('retry',{job_id:'job'}));
    expect(screen.getByText('2. Preview and review')).toHaveAttribute('aria-current','step');
    await screen.findByText('Newly recovered text',{}, {timeout:3500});
    expect(screen.queryByLabelText(/Save the available text and original file/i)).toBeNull();expect(screen.getByLabelText('I reviewed the converted text and all warnings.')).not.toBeChecked();expect(screen.getByRole('button',{name:'Continue'})).toBeDisabled();
    expect(vi.mocked(knowledgeImportRequest).mock.calls.filter(([action])=>action==='commit')).toHaveLength(1);
  });
  it('imports Markdown without the private processor and keeps Word and PDF waiting for it',async()=>{
    capability.processor_configured=false;
    render(<KnowledgeImportDialog open onOpenChange={vi.fn()} pages={[]} users={[]} actor={user()} onImported={vi.fn()}/>);
    await waitFor(()=>expect(screen.getByRole('button',{name:'Markdown .md'})).toHaveAttribute('aria-pressed','true'));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('Choose a file'),{target:{files:[new File(['# Note'],'note.md')]}});
    expect(screen.getByRole('button',{name:'Upload and parse privately'})).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'Word .docx'}));
    expect(screen.getByRole('alert')).toHaveTextContent(/Markdown and Notion import without it/);
    expect(screen.getByRole('button',{name:'Upload and parse privately'})).toBeDisabled();
  });
  it('checks a complete destination without a separate click',async()=>{
    const item={id:'item',title:'Ready note',status:'ready',original:{size:0},parsed:{body:'<p>Converted note</p>',warnings:[] as string[],pages:[] as never[],incomplete:false}};
    const job={id:'job',source:'md',status:'preview_ready',version:2,items:[item]};
    vi.mocked(knowledgeImportRequest).mockImplementation(async action=>action==='list'?[]:action==='start'?job:action==='preview_target'?{job,previous:[],current:null,duplicates:[]}:[]);
    render(<KnowledgeImportDialog open onOpenChange={vi.fn()} pages={[]} users={[]} actor={user()} onImported={vi.fn()}/>);
    await waitFor(()=>expect(screen.getByRole('button',{name:'Markdown .md'})).not.toBeDisabled());fireEvent.click(screen.getByRole('button',{name:'Markdown .md'}));fireEvent.change(screen.getByLabelText('Choose a file'),{target:{files:[new File(['# Note'],'note.md')]}});fireEvent.click(screen.getByRole('button',{name:'Upload and parse privately'}));
    await screen.findByText('Converted note');fireEvent.click(screen.getByLabelText('I reviewed the converted text and all warnings.'));fireEvent.click(screen.getByRole('button',{name:'Continue'}));
    expect(await screen.findByLabelText('I confirm the destination audience may read this source.')).not.toBeChecked();
    expect(vi.mocked(knowledgeImportRequest).mock.calls.filter(([action])=>action==='preview_target')).toHaveLength(1);
    expect(vi.mocked(knowledgeImportRequest).mock.calls.filter(([action])=>action==='commit')).toHaveLength(0);
  });
  it('rechecks the destination and retries only commit after a commit failure',async()=>{
    const item={id:'item',title:'Ready note',status:'ready',error:undefined as string|undefined,page_id:undefined as string|undefined,original:{size:0},parsed:{body:'<p>Converted note</p>',warnings:[] as string[],pages:[] as never[],incomplete:false}};
    let current={id:'job',source:'md',status:'preview_ready',version:2,items:[item]};let commits=0;
    vi.mocked(knowledgeImportRequest).mockImplementation(async action=>{if(action==='list')return [];if(action==='start')return current;if(action==='preview_target')return {job:current,previous:[],current:null,duplicates:[]};if(action==='commit'){commits++;current={...current,status:commits===1?'partially_failed':'succeeded',version:current.version+1,items:commits===1?[{...item,error:'commit_failed'}]:[{...item,status:'committed',page_id:'created'}]};return current;}return current;});
    render(<KnowledgeImportDialog open onOpenChange={vi.fn()} pages={[]} users={[]} actor={user()} onImported={vi.fn()}/>);
    await waitFor(()=>expect(screen.getByRole('button',{name:'Markdown .md'})).not.toBeDisabled());fireEvent.click(screen.getByRole('button',{name:'Markdown .md'}));fireEvent.change(screen.getByLabelText('Choose a file'),{target:{files:[new File(['# Note'],'note.md')]}});fireEvent.click(screen.getByRole('button',{name:'Upload and parse privately'}));
    await screen.findByText('Converted note');fireEvent.click(screen.getByLabelText('I reviewed the converted text and all warnings.'));fireEvent.click(screen.getByRole('button',{name:'Continue'}));fireEvent.click(screen.getByRole('button',{name:'Check destination and compare'}));fireEvent.click(await screen.findByLabelText('I confirm the destination audience may read this source.'));fireEvent.click(screen.getByRole('button',{name:'Confirm import'}));
    const retryCommit=await screen.findByRole('button',{name:'Review destination and retry import'});expect(screen.queryByRole('button',{name:'Retry failed items / OCR pages'})).toBeNull();fireEvent.click(retryCommit);
    expect(screen.getByRole('button',{name:'Confirm import'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Check destination and compare'}));const audience=await screen.findByLabelText('I confirm the destination audience may read this source.');expect(audience).not.toBeChecked();fireEvent.click(audience);fireEvent.click(screen.getByRole('button',{name:'Confirm import'}));
    await waitFor(()=>expect(commits).toBe(2));expect(vi.mocked(knowledgeImportRequest).mock.calls.filter(([action])=>action==='retry')).toHaveLength(0);
  });

  it('keeps a parsing job through a failed refresh and drops it only when the job is gone',async()=>{
    const parsing={id:'job',source:'md',status:'parsing',version:2,items:[{id:'item',title:'Long note',status:'pending',original:{size:10}}]};
    const ready={...parsing,status:'preview_ready',version:3,items:[{...parsing.items[0],status:'ready',parsed:{body:'<p>Converted long note</p>',warnings:[] as string[],pages:[] as never[],incomplete:false}}]};
    let refresh:()=>Promise<unknown>=async()=>parsing;
    vi.mocked(knowledgeImportRequest).mockImplementation(async action=>action==='list'?[]:action==='start'?parsing:action==='get'?refresh():[]);
    render(<KnowledgeImportDialog open onOpenChange={vi.fn()} pages={[]} users={[]} actor={user()} onImported={vi.fn()}/>);
    await waitFor(()=>expect(screen.getByRole('button',{name:'Markdown .md'})).not.toBeDisabled());fireEvent.click(screen.getByRole('button',{name:'Markdown .md'}));fireEvent.change(screen.getByLabelText('Choose a file'),{target:{files:[new File(['# Note'],'note.md')]}});fireEvent.click(screen.getByRole('button',{name:'Upload and parse privately'}));
    await screen.findByText('Parsing privately');
    // The Edge worker stopped while the private parse continued on the server.
    refresh=async()=>{throw new Error('import_interrupted');};act(()=>{window.dispatchEvent(new Event('focus'));});
    expect(await screen.findByText(/The server stopped while handling this document/)).toBeInTheDocument();
    expect(screen.getByText('Parsing privately')).toBeInTheDocument();
    refresh=async()=>ready;act(()=>{window.dispatchEvent(new Event('focus'));});
    await screen.findByText('Converted long note');expect(screen.queryByText(/The server stopped while handling this document/)).toBeNull();
    refresh=async()=>{throw new Error('job_not_found');};act(()=>{window.dispatchEvent(new Event('focus'));});
    expect(await screen.findByRole('button',{name:'Upload and parse privately'})).toBeInTheDocument();expect(screen.queryByText('Converted long note')).toBeNull();
  });
});
