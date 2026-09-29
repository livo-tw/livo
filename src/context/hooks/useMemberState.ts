import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { User } from '@/types';
import { mapUser } from '../mappers';

export function useMemberState() {
  const [users, setUsersInternal] = useState<User[]>([]);
  const [usersLoaded, setUsersLoaded] = useState(false);

  const setUsers = useCallback((u: User[]) => {
    setUsersInternal(u);
    setUsersLoaded(true);
  }, []);

  const refreshUsers = useCallback(async () => {
    const { data } = await supabase.from('members').select('*').order('sort_order');
    if (data) setUsers(data.map(mapUser));
  }, [setUsers]);

  return { users, setUsers, usersLoaded, refreshUsers };
}
