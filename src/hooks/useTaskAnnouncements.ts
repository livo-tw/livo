import { useMemo } from 'react';
import { useAuthContext } from '@/context/AuthContext';
import { useMemberContext } from '@/context/MemberContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useTaskContext } from '@/context/TaskContext';
import { useNotificationToast } from '@/components/notifications/NotificationToastProvider';
import type { TaskAnnouncementContext } from '@/lib/taskAnnouncements';

/** The context announceStatusChange / announceAssignment need, from the app's providers. */
export function useTaskAnnouncements(): TaskAnnouncementContext {
  const { currentMember } = useAuthContext();
  const { users } = useMemberContext();
  const { allProjects } = useProjectContext();
  const { statuses } = useTaskContext();
  const { triggerNotification } = useNotificationToast();
  return useMemo(() => ({ actor: currentMember, users, projects: allProjects, statuses, showRules: triggerNotification }),
    [currentMember, users, allProjects, statuses, triggerNotification]);
}
