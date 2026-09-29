import { createContext, useContext } from 'react';
import type { User } from '@/types';

export interface MemberContextType {
  users: User[];
  refreshUsers: () => Promise<void>;
}

export const MemberContext = createContext<MemberContextType | null>(null);

export const useMemberContext = () => {
  const ctx = useContext(MemberContext);
  if (!ctx) throw new Error('useMemberContext must be used within AppProvider');
  return ctx;
};
