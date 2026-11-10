import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const state=vi.hoisted(()=>({value:null as Record<string,unknown>|null,readError:false,conflict:false,writeError:false,writes:[] as Record<string,unknown>[],reads:0,deferSecond:false,release:undefined as undefined|(()=>void),success:vi.fn(),error:vi.fn()}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('sonner',()=>({toast:{success:state.success,error:state.error}}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:(table:string)=>{
  if(table!=='system_settings')throw new Error('wrong_setting_store');
  let patch:Record<string,unknown>|undefined,kind='';const filters:Record<string,unknown>={};
  const query={
    select:()=>{
      if(!patch)return query;
      if(state.writeError)return Promise.resolve({data:null,error:{message:'denied'}});
      if(state.conflict||(kind==='update'&&filters.value!==JSON.stringify(state.value))||(kind==='insert'&&state.value!==null))return Promise.resolve({data:[],error:null});
      state.value=structuredClone(patch.value as Record<string,unknown>);state.writes.push(structuredClone(patch));return Promise.resolve({data:[{value:structuredClone(state.value)}],error:null});
    },
    eq:(key:string,value:unknown)=>{filters[key]=value;return query;},
    maybeSingle:async():Promise<{data:{value:Record<string,unknown>}|null;error:{message:string}|null}>=>{
      state.reads++;if(state.deferSecond&&state.reads===2)await new Promise<void>(resolve=>{state.release=resolve;});
      return state.readError?{data:null as null,error:{message:'read_failed'}}:{data:state.value?{value:structuredClone(state.value)}:null,error:null};
    },
    update:(value:Record<string,unknown>)=>{patch=value;kind='update';return query;},
    insert:(value:Record<string,unknown>)=>{patch=value;kind='insert';return query;},
  };return query;
}}}));
import { AuthContext, type AuthContextType } from '@/context/AuthContext';
import SlackLinkPreviews from '@/components/integrations/SlackLinkPreviews';
import { readSlackPreviewMode, withSlackPreviewMode } from '@/lib/slackPreviewSettings';
const box=()=>screen.getByLabelText('integrations.slackPreviews.title') as HTMLSelectElement;
const view=(role='super_admin',id='example-member',demo=false)=><AuthContext.Provider value={{currentMember:{id,role},currentMemberId:id} as AuthContextType}><SlackLinkPreviews configured isDemoMode={demo}/></AuthContext.Provider>;
beforeEach(()=>{vi.clearAllMocks();Object.assign(state,{readError:false,conflict:false,writeError:false,writes:[],reads:0,deferSecond:false,release:undefined});state.value={enabled:false,teamId:'TEXAMPLE',routes:[{projectId:'example-project',channelId:'CTASK'}],qaRoutes:[{lineId:'example-line',channelId:'CBUG'}],dmEnabled:true,weekly:{enabled:true}};});
afterEach(cleanup);
describe('separate manual card-link preview policy',()=>{
  it('uses the existing project route policy by default without changing any setting on load',async()=>{
    render(view());await waitFor(()=>expect(box().disabled).toBe(false));expect(box().value).toBe('project_routes');expect(state.writes).toHaveLength(0);
  });
  it('changes only previewMode and preserves automatic notification routes and all other fields',async()=>{
    const original=structuredClone(state.value);render(view());await waitFor(()=>expect(box().disabled).toBe(false));fireEvent.change(box(),{target:{value:'internal_channels'}});
    await waitFor(()=>expect(state.writes).toHaveLength(1));expect(state.value).toEqual({...original,previewMode:'internal_channels'});expect(state.value?.enabled).toBe(false);
  });
  it('creates only the explicit preview policy when the setting row does not exist',async()=>{
    state.value=null;render(view());await waitFor(()=>expect(box().disabled).toBe(false));expect(state.writes).toHaveLength(0);
    fireEvent.change(box(),{target:{value:'internal_channels'}});await waitFor(()=>expect(state.writes).toHaveLength(1));expect(state.value).toEqual({previewMode:'internal_channels'});
  });
  it('shows the current policy to admins but leaves editing to super administrators',async()=>{
    state.value={...state.value,previewMode:'internal_channels'};render(view('admin'));await waitFor(()=>expect(box().value).toBe('internal_channels'));expect(box().disabled).toBe(true);fireEvent.change(box(),{target:{value:'project_routes'}});expect(state.writes).toHaveLength(0);
  });
  it('fails closed on unreadable or unknown policy instead of replacing it with a broader setting',async()=>{
    state.value={...state.value,previewMode:'unknown_policy'};render(view());await screen.findByRole('alert');expect(box().disabled).toBe(true);expect(state.writes).toHaveLength(0);
  });
  it('does not overwrite a concurrent settings change',async()=>{
    state.conflict=true;const original=structuredClone(state.value);render(view());await waitFor(()=>expect(box().disabled).toBe(false));fireEvent.change(box(),{target:{value:'internal_channels'}});await waitFor(()=>expect(state.error).toHaveBeenCalled());expect(state.value).toEqual(original);expect(state.writes).toHaveLength(0);
  });
  it('refuses writes after the signed-in actor changes during the fresh settings read',async()=>{
    state.deferSecond=true;const {rerender}=render(view());await waitFor(()=>expect(box().disabled).toBe(false));fireEvent.change(box(),{target:{value:'internal_channels'}});await waitFor(()=>expect(state.release).toBeDefined());
    rerender(view('super_admin','other-example-member'));state.release?.();await waitFor(()=>expect(box().disabled).toBe(false));expect(state.writes).toHaveLength(0);
  });
  it('disables writes in demo mode and rejects values outside the two explicit policies',()=>{
    render(view('super_admin','example-member',true));expect(box().disabled).toBe(true);expect(()=>readSlackPreviewMode('all_channels')).toThrow();expect(()=>withSlackPreviewMode({},'all_channels')).toThrow();expect(readSlackPreviewMode(undefined)).toBe('project_routes');expect(state.writes).toHaveLength(0);
  });
});
