import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKnowledgeNavigation } from '@/hooks/useKnowledgeNavigation';
import { emptyNavigation, type NavigationPreferences, type NavigationPage } from '../../worker/src/knowledgePreferenceModel';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({USING_MOCK_BACKEND:false,supabase:{rpc:mock.rpc}}));
const pages:NavigationPage[]=[{id:'a',parent_id:null,project_id:null,title:'Example private title',sort_order:0}];
beforeEach(()=>{localStorage.clear();mock.rpc.mockResolvedValue({data:emptyNavigation(),error:null});});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.clearAllMocks();});
describe('navigation persistence and recovery',()=>{
  it('does not retain optimistic success after a failed save',async()=>{
    const {result}=renderHook(()=>useKnowledgeNavigation('alpha:member',pages));
    await waitFor(()=>expect(result.current.status).toBe('synced'));
    mock.rpc.mockResolvedValueOnce({data:null,error:{message:'kb_forbidden'}});
    await act(()=>result.current.mutate({p_action:'pin',p_page_id:'a',p_value:true}));
    expect(result.current.preferences.pins).toEqual([]);expect(result.current.error).toBe('kb_forbidden');
  });
  it('retries a version conflict against the latest state without replacing another device preferences',async()=>{
    const {result}=renderHook(()=>useKnowledgeNavigation('alpha:member',pages));await waitFor(()=>expect(result.current.status).toBe('synced'));
    const latest={...emptyNavigation(),version:5};
    mock.rpc.mockResolvedValueOnce({data:null,error:{message:'kb_conflict'}}).mockResolvedValueOnce({data:latest,error:null}).mockResolvedValueOnce({data:{...latest,version:6,items:{a:{favorite:true,pinned:true}},pins:['a']},error:null});
    await act(()=>result.current.mutate({p_action:'pin',p_page_id:'a',p_value:true}));
    expect(mock.rpc).toHaveBeenLastCalledWith('kb_preferences',{p_action:'pin',p_page_id:'a',p_value:true,p_version:5});expect(result.current.preferences.pins).toEqual(['a']);
  });
  it('stores offline ID-only pending operations and synchronizes when online',async()=>{
    const online=vi.spyOn(navigator,'onLine','get').mockReturnValue(false);
    const {result}=renderHook(()=>useKnowledgeNavigation('alpha:member',pages));await waitFor(()=>expect(result.current.status).toBe('local'));
    await act(()=>result.current.mutate({p_action:'pin',p_page_id:'a',p_value:true}));
    const cached=localStorage.getItem(localStorage.key(0)!)!;expect(cached).not.toContain('Example private title');expect(JSON.parse(cached).pending).toHaveLength(1);
    online.mockReturnValue(true);mock.rpc.mockResolvedValueOnce({data:emptyNavigation(),error:null}).mockResolvedValueOnce({data:{...emptyNavigation(),version:1,items:{a:{favorite:true,pinned:true}},pins:['a']},error:null});
    await act(()=>result.current.refresh());expect(result.current.status).toBe('synced');expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!).pending).toEqual([]);
  });
  it('filters revoked IDs even before preference refresh finishes',async()=>{
    const value:NavigationPreferences={...emptyNavigation(),items:{a:{favorite:true,pinned:true}},pins:['a']};mock.rpc.mockResolvedValue({data:value,error:null});
    const {result,rerender}=renderHook(({visible})=>useKnowledgeNavigation('alpha:member',visible),{initialProps:{visible:pages}});await waitFor(()=>expect(result.current.preferences.pins).toEqual(['a']));
    rerender({visible:[]});expect(result.current.preferences.pins).toEqual([]);expect(result.current.preferences.items).toEqual({});
  });
});
