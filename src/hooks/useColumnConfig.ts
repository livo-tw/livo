import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuthContext } from '@/context/AuthContext';
import type { Json } from '@/integrations/supabase/types';

export interface ColumnDef {
  key: string;
  label: string;
  width?: string;
  fixed?: boolean;
}

export interface ColumnConfig {
  visibleKeys: string[];
  toggle: (key: string) => void;
  reorder: (from: number, to: number) => void;
  isVisible: (key: string) => boolean;
  visibleColumns: ColumnDef[];
  allColumns: ColumnDef[];
  resetToDefault: () => void;
}

export function useColumnConfig(
  storageKey: string,
  fixedColumns: ColumnDef[],
  optionalColumns: ColumnDef[],
  defaultVisible: string[],
): ColumnConfig {
  const allColumns = [...fixedColumns, ...optionalColumns];
  const { currentMemberId } = useAuthContext();
  const [visibleKeys, setVisibleKeys] = useState<string[]>(defaultVisible);
  const loaded = useRef(false);

  // Load from DB on mount / member change
  useEffect(() => {
    if (!currentMemberId) return;
    loaded.current = false;
    (async () => {
      const { data } = await supabase
        .from('user_column_configs')
        .select('visible_keys')
        .eq('member_id', currentMemberId)
        .eq('view_key', storageKey)
        .maybeSingle();
      if (data?.visible_keys) {
        setVisibleKeys(data.visible_keys as string[]);
      } else {
        setVisibleKeys(defaultVisible);
      }
      loaded.current = true;
    })();
  }, [currentMemberId, storageKey]);

  const persist = useCallback((keys: string[]) => {
    setVisibleKeys(keys);
    if (!currentMemberId) return;
    supabase
      .from('user_column_configs')
      .upsert(
        { member_id: currentMemberId, view_key: storageKey, visible_keys: keys as Json, updated_at: new Date().toISOString() },
        { onConflict: 'member_id,view_key' }
      )
      .then(({ error }) => { if (error) console.error('[LIVO] 儲存欄位設定失敗:', error.message); });
  }, [currentMemberId, storageKey]);

  const toggle = useCallback((key: string) => {
    if (fixedColumns.some(c => c.key === key)) return;
    const newKeys = visibleKeys.includes(key)
      ? visibleKeys.filter(k => k !== key)
      : [...visibleKeys, key];
    persist(newKeys);
  }, [visibleKeys, persist, fixedColumns]);

  const reorder = useCallback((from: number, to: number) => {
    const newKeys = [...visibleKeys];
    const [moved] = newKeys.splice(from, 1);
    newKeys.splice(to, 0, moved);
    persist(newKeys);
  }, [visibleKeys, persist]);

  const isVisible = useCallback((key: string) => {
    if (fixedColumns.some(c => c.key === key)) return true;
    return visibleKeys.includes(key);
  }, [visibleKeys, fixedColumns]);

  const visibleColumns: ColumnDef[] = [
    ...fixedColumns,
    ...visibleKeys
      .map(k => optionalColumns.find(c => c.key === k))
      .filter((c): c is ColumnDef => !!c),
  ];

  const resetToDefault = useCallback(() => {
    persist(defaultVisible);
  }, [persist, defaultVisible]);

  return { visibleKeys, toggle, reorder, isVisible, visibleColumns, allColumns, resetToDefault };
}
