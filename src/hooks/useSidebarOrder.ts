import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { emptySidebarOrder, parseSidebarOrder, sidebarSortMode, type SidebarOrder } from '@/lib/sidebarOrder';

const VIEW_KEY = 'sidebar-personal-order:v1';
type Snapshot = { identity: string; order: SidebarOrder; loading: boolean; saving: boolean; error: string | null; loaded: boolean };
const initial = (identity: string): Snapshot => ({ identity, order: emptySidebarOrder(), loading: Boolean(identity), saving: false, error: null, loaded: false });

/** Reuse the existing owner-scoped, workspace-filtered view preference store. */
export function useSidebarOrder(memberId: string) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => initial(memberId));
  const identity = useRef(memberId); identity.current = memberId;
  const generation = useRef(0);
  const inFlight = useRef(new Set<string>());
  const active = useRef(false);
  const [reloadEpoch, setReloadEpoch] = useState(0);
  const current = snapshot.identity === memberId ? snapshot : initial(memberId);
  const currentRef = useRef(current); currentRef.current = current;

  useEffect(() => {
    const serial = ++generation.current;
    active.current = true;
    setSnapshot(initial(memberId));
    const cleanup = () => { generation.current++; active.current = false; };
    if (!memberId) return cleanup;
    void (async () => {
      try {
        const { data, error } = await supabase.from('user_column_configs').select('visible_keys').eq('member_id', memberId).eq('view_key', VIEW_KEY).maybeSingle();
        if (error) throw new Error(error.message);
        const order = data ? parseSidebarOrder(data.visible_keys) : emptySidebarOrder();
        if (!order) throw new Error('invalid-sidebar-preference');
        if (identity.current === memberId && generation.current === serial) setSnapshot({ identity: memberId, order, loading: false, saving: false, error: null, loaded: true });
      } catch {
        if (identity.current === memberId && generation.current === serial) setSnapshot({ ...initial(memberId), loading: false, error: 'load', loaded: false });
      }
    })();
    return cleanup;
  }, [memberId, reloadEpoch]);

  const save = useCallback(async (value: Pick<SidebarOrder, 'lineOrder' | 'projectOrder' | 'sortMode'>): Promise<boolean> => {
    const owner = memberId, serial = generation.current;
    const order = parseSidebarOrder({ ...value, version: 1 });
    if (!owner || !order || inFlight.current.has(owner) || identity.current !== owner || !currentRef.current.loaded || currentRef.current.loading) return false;
    inFlight.current.add(owner);
    setSnapshot(prev => ({ ...prev, saving: true, error: null }));
    try {
      // Reconcile an earlier uncertain save before sending another upsert.
      const { data: existing, error: previewError } = await supabase.from('user_column_configs').select('visible_keys').eq('member_id', owner).eq('view_key', VIEW_KEY).maybeSingle();
      if (previewError) throw new Error(previewError.message);
      if (identity.current !== owner || generation.current !== serial) return false;
      const stored = existing && parseSidebarOrder(existing.visible_keys);
      if (existing && !stored) throw new Error('invalid-sidebar-preference');
      if (stored && JSON.stringify(stored) === JSON.stringify(order)) {
        setSnapshot({ identity: owner, order: stored, loading: false, saving: false, error: null, loaded: true });
        return true;
      }
      const { error } = await supabase.from('user_column_configs').upsert({ member_id: owner, view_key: VIEW_KEY, visible_keys: order as unknown as Json, updated_at: new Date().toISOString() }, { onConflict: 'member_id,view_key' });
      if (error) throw new Error(error.message);
      if (identity.current !== owner || generation.current !== serial) return false;
      const { data, error: readError } = await supabase.from('user_column_configs').select('visible_keys').eq('member_id', owner).eq('view_key', VIEW_KEY).maybeSingle();
      const confirmed = data && parseSidebarOrder(data.visible_keys);
      if (readError || !confirmed || JSON.stringify(confirmed) !== JSON.stringify(order)) throw new Error('sidebar-preference-readback');
      if (identity.current !== owner || generation.current !== serial) return false;
      setSnapshot({ identity: owner, order: confirmed, loading: false, saving: false, error: null, loaded: true });
      return true;
    } catch {
      if (identity.current === owner && generation.current === serial) setSnapshot(prev => ({ ...prev, saving: false, error: 'save' }));
      return false;
    } finally {
      inFlight.current.delete(owner);
      if (active.current && identity.current === owner) {
        if (generation.current !== serial) {
          // Returning to the same account must wait for its older write to finish,
          // then reload that committed result before permitting another save.
          setSnapshot(prev => ({ ...prev, loading: true, loaded: false }));
          setReloadEpoch(value => value + 1);
        } else {
          setSnapshot(prev => ({ ...prev, saving: false }));
        }
      }
    }
  }, [memberId]);

  return { sortMode: sidebarSortMode(current.order), lineOrder: current.order.lineOrder, projectOrder: current.order.projectOrder, loading: current.loading, saving: current.saving || inFlight.current.has(memberId), error: current.error, save };
}