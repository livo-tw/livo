import { useDeploymentQueueSettings } from '@/hooks/useDeploymentQueueSettings';
import { useDeploymentEnvironments } from '@/context/DeploymentEnvironmentContext';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAuthContext } from '@/context/AuthContext';
import { useUIContext } from '@/context/UIContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useMemberContext } from '@/context/MemberContext';
import { useTaskContext } from '@/context/TaskContext';
import { createQaClient, qaId } from '@/lib/qa/client';

export function useQa() {
  const { currentMember } = useAuthContext();
  const environments = useDeploymentEnvironments();
  const deployment = useDeploymentQueueSettings();
  const { featureToggles, featureTogglesReady } = useUIContext();
  const { allProjects } = useProjectContext();
  const { users } = useMemberContext();
  const { allTasks } = useTaskContext();
  const enabled = featureTogglesReady && featureToggles.qa === true;
  const latest = useRef({ enabled, currentMember, allProjects, users, allTasks, environments, deploymentOperator: deployment.isOperator });
  latest.current = { enabled, currentMember, allProjects, users, allTasks, environments, deploymentOperator: deployment.isOperator };
  useEffect(() => { latest.current.enabled = enabled; return () => { latest.current.enabled = false; }; }, [enabled]);
  const context = useCallback(() => {
    const value = latest.current;
    return { environmentValues: value.environments.ready ? value.environments.values : [], actor: { id: value.currentMember?.id || '', role: value.currentMember?.role || 'member', qaAdmin: value.currentMember?.qaAdmin === true, deploymentOperator: value.deploymentOperator }, workspaceId: 'default', now: new Date().toISOString(), newId: qaId,
      memberIds: new Set(value.users.filter(u => u.isActive).map(u => u.id)), projectIds: new Set(value.allProjects.filter(p => !p.isArchived).map(p => p.id)), taskIds: new Set(value.allTasks.map(t => t.id)) };
  }, []);
  const client = useMemo(() => createQaClient({ enabled: () => latest.current.enabled, context }), [context]);
  return { client, enabled, actor: { id: currentMember?.id || '', role: currentMember?.role || 'member', qaAdmin: currentMember?.qaAdmin === true, deploymentOperator: deployment.isOperator } };
}
