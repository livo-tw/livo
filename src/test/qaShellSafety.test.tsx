import type { QaDisplaySettings } from '@/lib/qa/displaySettings';
import type { QaState } from '@/lib/qa/domain';
import type { QaManualStateVisibility } from '@/lib/qa/manualStateVisibility';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProductLine, Task } from '@/types';
const mocks=vi.hoisted(()=>({mobile:false,mode:'side' as 'side'|'page'|'modal',command:vi.fn(),get:vi.fn(),getWorkflow:vi.fn(),getDisplaySettings: async (): Promise<QaDisplaySettings> => ({ version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] }), getManualStateVisibility: async (): Promise<QaManualStateVisibility> => ({ version: 1, hiddenStates: [] as QaState[] }), getFieldConfiguration:vi.fn(),versions:vi.fn(),list:vi.fn()}));
vi.mock('@/hooks/use-mobile',()=>({useIsMobile:()=>mocks.mobile}));
// Keep initialization exports available when an import graph loads the real i18n singleton.
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
import '@/i18n';
vi.mock('sonner',()=>({toast:{info:vi.fn(),success:vi.fn(),error:vi.fn()}}));
vi.mock('@/integrations/supabase/client',()=>({USING_MOCK_BACKEND:true,supabase:{}}));
vi.mock('@/context/MemberContext',()=>({useMemberContext:()=>({users:[{id:'admin',name:'Example admin',role:'admin',jobTitle:'',isActive:true}]})}));
vi.mock('@/context/ProjectContext',()=>({useProjectContext:()=>({allProjects:[{id:'p1',name:'Example project',isArchived:false}],productLines:[] as ProductLine[],selectedProjectId:null as string|null,setSelectedProjectId:vi.fn()})}));
vi.mock('@/context/TaskContext',()=>({useTaskContext:()=>({allTasks:[] as Task[]})}));
vi.mock('@/context/UIContext',()=>({useUIContext:()=>({taskDisplayMode:mocks.mode,setTaskDisplayMode:vi.fn(),setSelectedTask:vi.fn(),featureToggles:{qa:true},featureTogglesReady:true})}));
vi.mock('@/context/DeploymentEnvironmentContext',()=>({useDeploymentEnvironments:()=>({values:['Stage'],ready:true,loadError:false})}));
vi.mock('@/hooks/useQa',()=>{const client={command:mocks.command,get:mocks.get,getWorkflow:mocks.getWorkflow,getDisplaySettings: async (): Promise<QaDisplaySettings> => ({ version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] }), getManualStateVisibility: async (): Promise<QaManualStateVisibility> => ({ version: 1, hiddenStates: [] as QaState[] }), getFieldConfiguration:mocks.getFieldConfiguration,versions:mocks.versions,list:mocks.list};return {useQa:()=>({client,actor:{id:'admin',role:'admin'},enabled:true})};});
vi.mock('@/components/qa/QaKanban',()=>({default:({onOpen}:{onOpen:(id:string)=>void})=><button onClick={()=>onOpen('other-bug')}>Open background card</button>}));
import QaWorkspace from '@/components/qa/QaWorkspace';
import { createQaIssue } from '@/lib/qa/domain';
import { DEFAULT_QA_WORKFLOW } from '@/lib/qa/workflow';
import { hasQaNavigationGuard } from '@/lib/qa/navigationGuard';

const issue={...createQaIssue({projectId:'p1',title:'Protected issue',actual:'Unexpected result',observedEnvironment:'Stage'},'existing-bug',{actor:{id:'admin',role:'admin'},workspaceId:'default',now:'2026-10-03T00:00:00Z',newId:()=> 'event',memberIds:new Set(['admin']),projectIds:new Set(['p1']),taskIds:new Set()}),state:'verified' as const};
beforeEach(()=>{
  vi.clearAllMocks();mocks.command.mockReset();mocks.mobile=false;mocks.mode='side';window.history.replaceState({},'','/?qa=existing-bug');
  vi.stubGlobal('ResizeObserver',class{observe(){} unobserve(){} disconnect(){}});
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
  mocks.get.mockImplementation(async(id:string)=>({issue:{...issue,id,title:id==='existing-bug'?'Protected issue':'Other issue'},attachments:[],comments:[],events:[]}));
  mocks.getWorkflow.mockResolvedValue(DEFAULT_QA_WORKFLOW);mocks.getFieldConfiguration.mockResolvedValue({version:1,fields:[]});mocks.versions.mockResolvedValue([]);mocks.list.mockResolvedValue({issues:[],total:0,hasMore:false});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();Reflect.deleteProperty(HTMLElement.prototype,'scrollIntoView');expect(hasQaNavigationGuard()).toBe(false);});

describe('QA record shell preserves stateful work',()=>{
  it('puts the single mobile state control before the content tabs without weakening the command contract',async()=>{
    mocks.mobile=true;
    mocks.command.mockResolvedValueOnce({...issue,state:'failed',version:2});
    render(<QaWorkspace/>);await screen.findByRole('heading',{name:'Protected issue',level:1});
    await waitFor(()=>expect(screen.getByRole('combobox',{name:'qa.changeState'})).toBeEnabled());
    const control=screen.getByRole('combobox',{name:'qa.changeState'});
    expect(control.compareDocumentPosition(screen.getByRole('tablist',{name:'qa.details'})) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(control);fireEvent.click(await screen.findByRole('option',{name:'qa.state.failed'}));
    await waitFor(()=>expect(mocks.command).toHaveBeenCalledTimes(1));
    expect(mocks.command.mock.calls[0][1]).toMatchObject({type:'set_state',state:'failed'});
    expect(screen.getAllByRole('combobox',{name:'qa.changeState'})).toHaveLength(1);
  });
  it.each(['back','other-card'])('retains an unknown state command when the side panel background requests %s',async(target)=>{
    mocks.command.mockRejectedValueOnce({status:503,code:'temporarily_unavailable'}).mockResolvedValueOnce({...issue,state:'failed',version:2});
    render(<QaWorkspace/>);await screen.findByRole('heading',{name:'Protected issue',level:1});
    await waitFor(()=>expect(screen.getByRole('combobox',{name:'qa.changeState'})).toBeEnabled());
    fireEvent.click(screen.getByRole('combobox',{name:'qa.changeState'}));fireEvent.click(await screen.findByRole('option',{name:'qa.state.failed'}));
    await screen.findByText('qa.commandRetryHint');const sent=mocks.command.mock.calls[0].slice(0,3);
    if(target==='back') fireEvent.click(screen.getAllByRole('button',{name:'qa.back'})[0]);
    else fireEvent.click(screen.getByRole('button',{name:'Open background card'}));
    expect(window.location.search).toBe('?qa=existing-bug');
    expect(screen.getByText('qa.commandRetryHint')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'qa.retryCommand'}));
    await waitFor(()=>expect(mocks.command).toHaveBeenCalledTimes(2));
    expect(mocks.command.mock.calls[1].slice(0,3)).toEqual(sent);
  });
  it('keeps the same report edit DOM and values through side/page/modal changes',async()=>{
    const {rerender}=render(<QaWorkspace/>);await screen.findByRole('heading',{name:'Protected issue',level:1});
    fireEvent.click(screen.getByRole('button',{name:'qa.moreActions'}));fireEvent.click(await screen.findByRole('menuitem',{name:'qa.edit'}));
    const title=await screen.findByLabelText(/qa.titleField/);fireEvent.change(title,{target:{value:'Draft revision'}});
    for(const mode of ['page','modal','side'] as const){mocks.mode=mode;rerender(<QaWorkspace/>);expect(screen.getByLabelText(/qa.titleField/)).toBe(title);expect(title).toHaveValue('Draft revision');}
  });
});
