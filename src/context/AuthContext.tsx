import { createContext, useContext } from 'react';
import type { User } from '@/types';
import type { Permissions } from '@/lib/permissions';
import type { ThemeKey } from '@/lib/themes';

export interface AuthContextType {
  currentMemberId: string;
  setCurrentMemberId: (id: string) => void;
  currentMember: User | null;
  realMemberId: string;
  realMember: User | null;
  permissions: Permissions;
  userTheme: ThemeKey;
  setUserTheme: (theme: ThemeKey) => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | null>(null);

export const useAuthContext = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthContext must be used within AppProvider');
  return ctx;
};
