import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthContext, type AuthContextType } from '@/context/AuthContext';
import { MemberContext } from '@/context/MemberContext';
import { ProjectContext, type ProjectContextType } from '@/context/ProjectContext';
import { DEFAULT_REQUIRED_FIELDS, UIContext, type TaskDisplayMode, type UIContextType } from '@/context/UIContext';
import { ExternalQaContext } from '@/context/ExternalQaContext';
import { ScopedDeploymentEnvironmentProvider } from '@/context/DeploymentEnvironmentContext';
import { supabase } from '@/integrations/supabase/client';
import { getPermissions } from '@/lib/permissions';
import { scopeChangeBlocked } from '@/hooks/useProjectScope';
import { type QaCreateIntent } from '@/lib/qa/navigationGuard';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { groupProjectsByLine } from '@/lib/projectGroups';
import type { ExternalQaProfile } from '@/lib/qa/externalProfile';
import type { User } from '@/types';
import QaWorkspace from './QaWorkspace';

function unavailable(): never { throw new Error('external-qa-unavailable'); }

export default function ExternalQaShell({ profile, reload }: { profile: ExternalQaProfile; reload: () => Promise<void> }) {
  const { t } = useTranslation();
  const [view, setView] = useState<'qa' | 'my-qa'>('qa');
  const [selected, setSelected] = useState<string | null>(null);
  const [taskDisplayMode, setTaskDisplayMode] = useState<TaskDisplayMode>('modal');
  const selectedProjectId = profile.projects.some(project => project.id === selected) ? selected : null;
  const canReport = profile.qaEnabled && profile.projects.some(project => !project.isArchived && (!selectedProjectId || project.id === selectedProjectId));
  const createBug = () => {
    if (!canReport || scopeChangeBlocked()) return;
    const intent: QaCreateIntent = { handled: false, accepted: false };
    window.dispatchEvent(new CustomEvent<QaCreateIntent>('livo:qa-create', { detail: intent }));
  };
  const selectProject = (id: string | null) => {
    if (id !== null && !profile.projects.some(project => project.id === id)) return;
    if (!scopeChangeBlocked()) setSelected(id);
  };
  const selectView: UIContextType['setCurrentView'] = (next, onAccepted) => {
    if ((next !== 'qa' && next !== 'my-qa') || next === view || scopeChangeBlocked()) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('qa'); url.searchParams.delete('qaCreate');
    window.history.replaceState({}, '', url.toString());
    setView(next);
    onAccepted?.();
  };
  const existingSelf = profile.members.find(member => member.id === profile.id);
  const self: User = existingSelf ?? {
    id: profile.id, name: profile.name, avatar: profile.name.slice(0, 1), color: '#64748b',
    jobTitle: '', email: '', role: 'member', isActive: true, sortOrder: 0,
  };
  const users = existingSelf ? profile.members : [self, ...profile.members];
  const auth: AuthContextType = {
    currentMemberId: self.id, realMemberId: self.id, currentMember: self, realMember: self,
    setCurrentMemberId: unavailable, permissions: getPermissions('member'), userTheme: 'dark', setUserTheme: unavailable,
  };
  const project: ProjectContextType = {
    allProjects: profile.projects, selectedProjectId, setSelectedProjectId: selectProject, setAllProjects: unavailable,
    selectedLineId: null, setSelectedLineId: id => { if (id !== null) unavailable(); }, productLines: [], refreshProductLines: reload,
    createProjectInDb: unavailable, updateProjectInDb: unavailable, deleteProjectInDb: unavailable,
    createProductLineInDb: unavailable, updateProductLineInDb: unavailable, deleteProductLineInDb: unavailable,
  };
  const ui: UIContextType = {
    featureToggles: { qa: profile.qaEnabled, approvals: false, slackActions: false, releases: false, deploymentQueue: false },
    featureTogglesReady: true, featureTogglesError: null, approvalsEnabled: false,
    refreshFeatureToggles: reload, saveFeatureToggle: unavailable, currentView: view, setCurrentView: selectView,
    selectedTask: null, setSelectedTask: unavailable, standupMode: false, setStandupMode: unavailable,
    standupUserId: null, setStandupUserId: unavailable, showCreateProject: false, setShowCreateProject: unavailable,
    showCreateTask: false, setShowCreateTask: unavailable, createTaskSeed: null, openCreateSubtask: unavailable,
    editingProject: null, setEditingProject: unavailable, taskDisplayMode, setTaskDisplayMode,
    requiredFields: DEFAULT_REQUIRED_FIELDS, setRequiredFields: unavailable, saveRequiredFields: unavailable, isLoading: false,
  };

  return <ExternalQaContext.Provider value={true}>
    <AuthContext.Provider value={auth}>
      <ScopedDeploymentEnvironmentProvider values={profile.environments} reload={reload}>
        <MemberContext.Provider value={{ users, refreshUsers: reload }}>
          <ProjectContext.Provider value={project}>
            <UIContext.Provider value={ui}>
              <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
                <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                  <h1 className="mr-auto text-sm font-semibold">{t('qa.externalWorkspace')}</h1>
                  <span className="text-sm text-muted-foreground">{profile.name}</span>
                  {canReport && <button type="button" className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={createBug}>
                    {t('qa.report')}
                  </button>}
                  <button type="button" className="rounded border border-border px-3 py-1.5 text-sm" onClick={() => void supabase.auth.signOut()}>{t('auth.logout')}</button>
                </header>
                {profile.qaEnabled && profile.projects.length > 0 ? <>
                  <nav aria-label={t('qa.title')} className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
                    <button type="button" aria-pressed={view === 'qa'} className="rounded px-3 py-1.5 text-sm aria-pressed:bg-accent" onClick={() => selectView('qa')}>{t('qa.title')}</button>
                    <button type="button" aria-pressed={view === 'my-qa'} className="rounded px-3 py-1.5 text-sm aria-pressed:bg-accent" onClick={() => selectView('my-qa')}>{t('qa.myTitle')}</button>
                    <SearchableSelect aria-label={t('qa.project')} value={selectedProjectId ?? ''} onChange={event => selectProject(event.target.value || null)}
                      className="rounded border border-border bg-background px-3 py-1.5 text-sm">
                      <option value="">{t('qa.externalAllProjects')}</option>
                      <ProjectSelectOptions groups={groupProjectsByLine([], profile.projects, { archived: 'all' })} />
                    </SearchableSelect>
                  </nav>
                  <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                    <QaWorkspace mine={view === 'my-qa'} />
                  </main>
                </> : <p role="status" className="p-6 text-sm text-muted-foreground">{t(profile.qaEnabled ? 'qa.externalNoProjects' : 'qa.disabled')}</p>}
              </div>
            </UIContext.Provider>
          </ProjectContext.Provider>
        </MemberContext.Provider>
      </ScopedDeploymentEnvironmentProvider>
    </AuthContext.Provider>
  </ExternalQaContext.Provider>;
}
