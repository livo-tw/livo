import {act,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
import {AuthContext} from '@/context/AuthContext';
import type {KnowledgeWorkflowData,KnowledgeChecklistItem} from '@/lib/knowledgeWorkflowDomain';
import {useKnowledgeWorkflow} from '@/hooks/useKnowledgeWorkflow';
import {KnowledgeChecklist} from './KnowledgeChecklist';
import RelatedKnowledge from './RelatedKnowledge';
const request=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/knowledgeWorkflowClient',()=>({knowledgeWorkflowRequest:request}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};};
const data=(id:string):KnowledgeWorkflowData=>({pageVersion:1,checklist:[{id,pageId:id,anchorId:'anchor',text:id,isDone:false,version:1,linkedWorkId:null,updatedBy:'planning',updatedAt:'2026-10-03',completedBy:null,completedAt:null}],links:[],snapshots:[]});
let member={id:'planning',role:'member',jobTitle:'PM'};
const Wrapper=({children}:{children:ReactNode})=><AuthContext.Provider value={{currentMember:member} as never}>{children}</AuthContext.Provider>;
beforeEach(()=>{request.mockReset();member={id:'planning',role:'member',jobTitle:'PM'};});
describe('knowledge workflow UI access and persistence',()=>{
 it('does not query or reveal backlinks without an authenticated member',()=>{
  render(<RelatedKnowledge targetKind="task" targetId="task"/>);expect(request).not.toHaveBeenCalled();expect(screen.queryByRole('link')).toBeNull();
 });
 it('removes backlinks immediately when the member position changes',async()=>{
  request.mockResolvedValueOnce({items:[{linkId:'link',pageId:'private',title:'Private title',category:'meeting',anchorId:'anchor',relation:'meeting'}]});
  const next=deferred<{items:never[]}>();request.mockImplementationOnce(()=>next.promise);
  const view=render(<Wrapper><RelatedKnowledge targetKind="task" targetId="task"/></Wrapper>);
  expect(await screen.findByText('Private title')).toBeInTheDocument();member={...member,jobTitle:'Engineer'};view.rerender(<Wrapper><RelatedKnowledge targetKind="task" targetId="task"/></Wrapper>);
  expect(screen.queryByText('Private title')).toBeNull();await act(async()=>{next.resolve({items:[]});});expect(screen.queryByRole('link')).toBeNull();
 });
 it('discards late responses for an earlier page',async()=>{
  const old=deferred<ReturnType<typeof data>>(),fresh=deferred<ReturnType<typeof data>>();request.mockImplementationOnce(()=>old.promise).mockImplementationOnce(()=>fresh.promise);
  const hook=renderHook(({page})=>useKnowledgeWorkflow(page),{initialProps:{page:'old'},wrapper:Wrapper});hook.rerender({page:'new'});
  await act(async()=>{fresh.resolve(data('new'));});expect(hook.result.current.data?.checklist[0].id).toBe('new');
  await act(async()=>{old.resolve(data('old'));});expect(hook.result.current.data?.checklist[0].id).toBe('new');
 });
 it('clears data after permission loss and never restores a late authorized response',async()=>{
  request.mockResolvedValueOnce(data('private'));const old=deferred<ReturnType<typeof data>>();
  const hook=renderHook(()=>useKnowledgeWorkflow('private'),{wrapper:Wrapper});await waitFor(()=>expect(hook.result.current.data).not.toBeNull());
  request.mockImplementationOnce(()=>old.promise);let pending:Promise<void>;act(()=>{pending=hook.result.current.refresh();});
  member={...member,jobTitle:'Engineer'};request.mockRejectedValueOnce(new Error('kb_workflow_unavailable'));hook.rerender();expect(hook.result.current.data).toBeNull();
  await act(async()=>{old.resolve(data('private'));await pending!;});await waitFor(()=>expect(hook.result.current.data).toBeNull());
 });
 it('uses a persisted controlled checkbox and removes the second status after linking',()=>{
  const item:KnowledgeChecklistItem={...data('source').checklist[0]};const onSet=vi.fn().mockResolvedValue(undefined);
  const props={items:[item],canEdit:true,busy:false,onSet,onAdd:vi.fn(),onDelete:vi.fn(),onLink:vi.fn()};const view=render(<KnowledgeChecklist {...props}/>);
  fireEvent.click(screen.getByRole('checkbox'));expect(onSet).toHaveBeenCalledWith(item,true);expect(screen.getByRole('checkbox')).not.toBeChecked();
  view.rerender(<KnowledgeChecklist {...props} canEdit={false}/>);expect(screen.getByRole('checkbox')).toBeDisabled();
  view.rerender(<KnowledgeChecklist {...props} items={[{...item,linkedWorkId:'link'}]}/>);expect(screen.queryByRole('checkbox')).toBeNull();
 });
});
