import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { sessionQueries, memberDurationQueries } from '@/lib/standupQueries';

export type SortMode = 'by_member' | 'by_project' | 'by_due_date' | 'by_department';

export interface StandupSettings {
  defaultSpeakDuration: number;
  sortMode: SortMode;
  autoAdvance: boolean;
  bufferSeconds: number;
  memberDurations: Record<string, number>;
}

const LS_KEY = 'livo_standup_settings';

const DEFAULT_SETTINGS: StandupSettings = {
  defaultSpeakDuration: 120,
  sortMode: 'by_member',
  autoAdvance: true,
  bufferSeconds: 15,
  memberDurations: {},
};

function loadFromLocalStorage(): StandupSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistToLocalStorage(s: StandupSettings): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function useStandupSettings(memberIds: string[]) {
  const [settings, setSettings] = useState<StandupSettings>(loadFromLocalStorage);
  // Track active session ID for DB updates
  const sessionIdRef = useRef<string | null>(null);

  // On mount: load from DB first, fallback to localStorage
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await sessionQueries.fetchActive(supabase);
        if (!cancelled && !error && data) {
          sessionIdRef.current = data.id;
          // Load member durations for this session
          const { data: durRows } = await memberDurationQueries.fetchBySession(supabase, data.id);
          const memberDurations: Record<string, number> = {};
          if (durRows) {
            for (const row of durRows) {
              memberDurations[row.member_id] = row.speak_duration;
            }
          }
          const dbSettings: StandupSettings = {
            defaultSpeakDuration: data.default_speak_duration,
            sortMode: data.sort_mode,
            autoAdvance: data.auto_advance,
            bufferSeconds: data.buffer_seconds,
            memberDurations,
          };
          setSettings(dbSettings);
          persistToLocalStorage(dbSettings);
          return;
        }
        // No active session — create one
        if (!cancelled && !error && !data) {
          const { data: authData } = await supabase.auth.getUser();
          if (authData?.user) {
            const localSettings = loadFromLocalStorage();
            const { data: newSession, error: createError } = await sessionQueries.create(supabase, {
              created_by: authData.user.id,
              started_at: new Date().toISOString(),
              ended_at: null,
              sprint_id: null,
              default_speak_duration: localSettings.defaultSpeakDuration,
              sort_mode: localSettings.sortMode,
              auto_advance: localSettings.autoAdvance,
              buffer_seconds: localSettings.bufferSeconds,
            });
            if (!cancelled && !createError && newSession) {
              sessionIdRef.current = newSession.id;
            }
          }
        }
      } catch {
        // DB unavailable — fall through to localStorage
      }
      if (!cancelled) {
        setSettings(loadFromLocalStorage());
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const updateSettings = useCallback((patch: Partial<StandupSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      persistToLocalStorage(next);
      // Best-effort DB save if active session exists
      if (sessionIdRef.current) {
        void sessionQueries.update(supabase, sessionIdRef.current, {
          default_speak_duration: next.defaultSpeakDuration,
          sort_mode: next.sortMode,
          auto_advance: next.autoAdvance,
          buffer_seconds: next.bufferSeconds,
        });
      }
      return next;
    });
  }, []);

  const setMemberDuration = useCallback((memberId: string, duration: number) => {
    setSettings(prev => {
      const next = {
        ...prev,
        memberDurations: { ...prev.memberDurations, [memberId]: duration },
      };
      persistToLocalStorage(next);
      // Best-effort DB save if active session exists
      if (sessionIdRef.current) {
        void memberDurationQueries.upsert(supabase, {
          standup_session_id: sessionIdRef.current,
          member_id: memberId,
          speak_duration: duration,
        });
      }
      return next;
    });
  }, []);

  const resetMemberDuration = useCallback((memberId: string) => {
    setSettings(prev => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [memberId]: _, ...rest } = prev.memberDurations;
      return { ...prev, memberDurations: rest };
    });
  }, []);

  const getDurationForMember = useCallback((memberId: string) => {
    return settings.memberDurations[memberId] ?? settings.defaultSpeakDuration;
  }, [settings]);

  const calculateTotalDuration = useCallback(() => {
    return memberIds.reduce((sum, id) => sum + getDurationForMember(id), 0);
  }, [memberIds, getDurationForMember]);

  return {
    settings,
    setSettings,
    updateSettings,
    setMemberDuration,
    updateMemberDuration: setMemberDuration,
    resetMemberDuration,
    getDurationForMember,
    calculateTotalDuration,
    sessionIdRef,
  };
};