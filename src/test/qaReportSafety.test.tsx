import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QaReportForm from '@/components/qa/QaReportForm';
import { createQaIssue } from '@/lib/qa/domain';
import type { QaFieldConfiguration } from '@/lib/qa/fields';

vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('@/context/DeploymentEnvironmentContext',()=>({useDeploymentEnvironments:()=>({ready:true,values:['Stage'],loadError:false})}));
const issue=createQaIssue({projectId:'p1',title:'Existing report',actual:'Unexpected result',observedEnvironment:'Stage'},'issue',{actor:{id:'reporter',role:'member'},workspaceId:'default',now:'2026-10-03T00:00:00Z',newId:()=> 'event',memberIds:new Set(['reporter']),projectIds:new Set(['p1']),taskIds:new Set()});
const configuration:QaFieldConfiguration={version:1,fields:[
  {id:'reason',fieldName:'Reason',fieldType:'text',isEnabled:true,isRequired:true,sortOrder:0},
  {id:'disabled',fieldName:'Historical disabled',fieldType:'text',isEnabled:false,isRequired:false,sortOrder:1},
  {id:'retired',fieldName:'Retired choice',fieldType:'select',options:['Current'],isEnabled:true,isRequired:false,sortOrder:2},
]};
const project={id:'p1',lineId:'line',name:'Example project',key:'EX',color:'#123456',isArchived:false};
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){} unobserve(){} disconnect(){}});
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();Reflect.deleteProperty(HTMLElement.prototype,'scrollIntoView');});

describe('QA report catalog and history preservation',()=>{
  it('keeps disabled, unknown and retired custom values when editing only the report title',async()=>{
    const customFields={reason:'Observed',disabled:'Old evidence',retired:'Old choice',unknown:'Imported value'},submit=vi.fn();
    const client={versions:vi.fn().mockResolvedValue([]),getFieldConfiguration:vi.fn().mockResolvedValue(configuration)};
    render(<QaReportForm initial={{...issue,customFields}} projects={[project]} productLines={[]} client={client} busy={false} onSubmit={submit} onCancel={()=>{}}/>);
    await screen.findByLabelText(/^Reason/);fireEvent.change(screen.getByLabelText(/qa.titleField/),{target:{value:'Revised report'}});
    fireEvent.click(screen.getByRole('button',{name:'qa.save'}));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({title:'Revised report',customFields}));
  });
  it('blocks report submission while catalog retrieval fails and recovers only after a successful retry',async()=>{
    const submit=vi.fn(),client={versions:vi.fn().mockResolvedValue([]),getFieldConfiguration:vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(configuration)};
    render(<QaReportForm initial={{...issue,customFields:{reason:'Observed'}}} projects={[project]} productLines={[]} client={client} busy={false} onSubmit={submit} onCancel={()=>{}}/>);
    await screen.findByRole('alert');expect(screen.getByRole('button',{name:'qa.save'})).toBeDisabled();
    fireEvent.submit(screen.getByLabelText(/qa.titleField/).closest('form')!);expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'qa.refresh'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'qa.save'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:'qa.save'}));expect(submit).toHaveBeenCalledTimes(1);
  });
});
