import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import KnowledgeNavigation from '@/components/knowledge/KnowledgeNavigation';
import KnowledgeReadingBody, { splitMeetingBody } from '@/components/knowledge/KnowledgeReadingBody';
import { applyNavigation, emptyNavigation, type NavigationCommand, type NavigationPreferences } from '../../worker/src/knowledgePreferenceModel';
import type { KnowledgePage } from '@/types/knowledge';
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string,options?:{defaultValue?:string})=>options?.defaultValue||key})}));
const pages=[{id:'parent',title:'Example folder',parent_id:null},{id:'a',title:'Guide A',parent_id:'parent'},{id:'b',title:'Guide B',parent_id:'parent'}].map((page,index)=>({...page,project_id:null as string | null,sort_order:index,body:'<p>Example</p>',version:1,is_archived:false,admin_only:false,created_by:'example',updated_by:'example',created_at:'2026-01-01',updated_at:'2026-01-01'})) satisfies KnowledgePage[];
const change=vi.fn(),select=vi.fn();
function Harness({filtered=false,selectedId=null,initial=emptyNavigation()}:{filtered?:boolean;selectedId?:string|null;initial?:NavigationPreferences}){
  const [preferences,setPreferences]=useState(initial);
  const navigation={preferences,mutate:async(command:NavigationCommand)=>{change(command);setPreferences(old=>applyNavigation(old,pages,command));return true;},refresh:async()=>{},saving:false,status:'synced' as const,error:''};
  return <KnowledgeNavigation pages={pages} groups={[{id:'shared',name:'Shared'}]} query="" filtered={filtered} selectedId={selectedId} onSelect={select} navigation={navigation} scopeName={()=>'Shared'}/>;
}
afterEach(()=>{cleanup();vi.clearAllMocks();vi.restoreAllMocks();});
describe('knowledge navigation interactions',()=>{
  it('separates opening a parent from its persisted collapse control',async()=>{
    render(<Harness/>);expect(screen.queryByRole('button',{name:'Guide A'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Example folder'}));expect(select).toHaveBeenCalledWith('parent');expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Expand: Example folder'}));await screen.findByRole('button',{name:'Guide A'});
    expect(change).toHaveBeenCalledWith({p_action:'collapse',p_page_id:'parent',p_value:false});
  });
  it('temporarily expands filtered results without overwriting ordinary preferences',async()=>{
    const view=render(<Harness filtered/>);
    expect(screen.getByRole('button',{name:'Adjust my order'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Guide A'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Collapse: Example folder'}));
    fireEvent.click(screen.getByRole('button',{name:'Expand: Example folder'}));await screen.findByRole('button',{name:'Guide A'});expect(change).not.toHaveBeenCalled();
    view.rerender(<Harness/>);await waitFor(()=>expect(screen.queryByRole('button',{name:'Guide A'})).not.toBeInTheDocument());
  });
  it('offers keyboard/mobile move actions that only reorder siblings',async()=>{
    render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'Expand: Example folder'}));
    fireEvent.click(screen.getByRole('button',{name:'Adjust my order'}));
    const menu=screen.getByLabelText('Move options: Guide B');fireEvent.click(menu);
    const details=menu.closest('details')!;fireEvent.click(details.querySelectorAll('button')[0]);
    await waitFor(()=>expect(change).toHaveBeenCalledWith({p_action:'reorder',p_page_id:'b',p_before_id:'a',p_order_kind:'tree'}));
  });
  it('moves a focused child with the real keyboard sensor without colliding with its expanded parent',async()=>{
    vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
      const id=this.dataset.kbRow,top=id==='parent'?0:id==='a'?50:id==='b'?100:0;
      return {x:0,y:top,left:0,top,right:260,bottom:top+44,width:260,height:44,toJSON:()=>({})};
    });
    render(<Harness selectedId="b"/>);
    await screen.findByRole('button',{name:'Guide B'});
    fireEvent.click(screen.getByRole('button',{name:'Adjust my order'}));
    const handle=screen.getByRole('button',{name:'Move in my order: Guide B'});handle.focus();
    fireEvent.keyDown(handle,{key:' ',code:'Space'});
    await waitFor(()=>expect(handle).toHaveAttribute('aria-pressed','true'));
    fireEvent.keyDown(handle,{key:'ArrowUp',code:'ArrowUp'});
    await waitFor(()=>expect(screen.getByText(/moved over droppable area a/)).toBeInTheDocument());
    fireEvent.keyDown(handle,{key:' ',code:'Space'});
    await waitFor(()=>expect(change).toHaveBeenCalledWith({p_action:'reorder',p_page_id:'b',p_before_id:'a',p_order_kind:'tree'}));
  });
  it('temporarily reveals a deep-linked page without overwriting saved collapse',async()=>{
    render(<Harness selectedId="a" initial={{...emptyNavigation(),items:{parent:{favorite:false,pinned:false,collapsed:true}}}}/>);
    await screen.findByRole('button',{name:'Guide A'});expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Collapse: Example folder'}));
    await waitFor(()=>expect(screen.queryByRole('button',{name:'Guide A'})).not.toBeInTheDocument());
    expect(change).toHaveBeenCalledWith({p_action:'collapse',p_page_id:'parent',p_value:true});
  });
  it('pins imply favorites, unpin keeps favorite, and favorites have their own view',async()=>{
    render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'Pin for me: Example folder'}));
    await waitFor(()=>expect(screen.getAllByRole('button',{name:'Remove favorite: Example folder'})[0]).toHaveAttribute('aria-pressed','true'));
    fireEvent.click(screen.getAllByRole('button',{name:'Unpin: Example folder'})[0]);
    fireEvent.click(screen.getByRole('button',{name:'My favorites'}));
    expect(screen.getAllByRole('button',{name:'Remove favorite: Example folder'})).toHaveLength(1);
    expect(screen.getByRole('button',{name:'Pin for me: Example folder'})).toHaveAttribute('aria-pressed','false');
  });
});

describe('meeting source reading',()=>{
  it('collapses only the source portion and never changes original source text or creates fake checkboxes',()=>{
    const original='<h2>Decision</h2><p>Example approved rule.</p><h2>Full meeting record</h2><p>[ ] Historical action</p><script>alert(1)</script>';
    const result=splitMeetingBody(original);expect(result.overview).toContain('Example approved rule');expect(result.overview).not.toContain('Historical action');expect(result.source).toContain('[ ] Historical action');expect(result.source).not.toContain('<script');
    const {container}=render(<KnowledgeReadingBody body={original} meeting/>);
    expect(container.querySelector('details')).not.toHaveAttribute('open');expect(container.querySelector('input')).toBeNull();
    expect(original).toContain('<script>');
  });
  it('keeps unstructured records intact and labels text marks rather than inventing working inputs',()=>{
    const body='<h2>Example discussion</h2><p>[ ] Verify an old statement.</p>';
    expect(splitMeetingBody(body)).toEqual({overview:body,source:null});
    const {container}=render(<KnowledgeReadingBody body={body} meeting/>);
    expect(screen.getByText(/Text check marks belong/)).toBeInTheDocument();expect(container.querySelector('input')).toBeNull();
    expect(screen.getByText('[ ] Verify an old statement.')).toBeInTheDocument();
  });
  it('recognizes a source heading within a wrapper without losing trailing content',()=>{
    const split=splitMeetingBody('<section><p>Decision</p><h2>Full meeting minutes</h2><p>Source inside wrapper</p></section><p>Source link</p>');
    expect(split.overview).toContain('Decision');expect(split.overview).not.toContain('Source inside wrapper');
    expect(split.source).toContain('Source inside wrapper');expect(split.source).toContain('Source link');
  });
});
