import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { AppProvider } from '@/context/AppContext';
import { useAuthContext } from '@/context/AuthContext';
import { resolveApprovalView, resolveQaView, resolveReleaseView } from '@/lib/featureToggles';
import ProjectScopeBar from '@/components/project/ProjectScopeBar';
import { SCOPED_VIEWS } from '@/hooks/useProjectScope';
import { useUIContext } from '@/context/UIContext';
import { useTaskContext } from '@/context/TaskContext';
import { LicenseProvider, useLicense } from '@/context/LicenseContext';
import UndoStackProvider from '@/components/UndoStackProvider';
import OnboardingGuide from '@/components/OnboardingGuide';
import UpgradePrompt from '@/components/UpgradePrompt';
import AppSidebar from '@/components/AppSidebar';
import TopBar from '@/components/TopBar';
import BoardView from '@/components/BoardView';
import TaskDetailContent from '@/components/TaskDetailContent';
import TaskDetailModal from '@/components/TaskDetailModal';
import StandupPanel from '@/components/StandupPanel';
import CreateProjectModal from '@/components/CreateProjectModal';
import CreateTaskModal from '@/components/CreateTaskModal';
import ActivityLogView from '@/components/ActivityLogView';
import MyTasksView from '@/components/MyAssignments';
import { MyAssignmentsProvider } from '@/context/MyAssignmentsContext';
import MySettingsView from '@/components/MySettingsView';
import TeamManageView from '@/components/TeamManageView';
import PendingApprovalList from '@/components/approval/PendingApprovalList';
import { NotificationToastProvider } from '@/components/notifications/NotificationToastProvider';
import { useTaskHistory } from '@/hooks/useTaskHistory';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMediaQuery } from '@/hooks/use-media-query';
import ErrorBoundary from '@/components/ErrorBoundary';
import CommandPalette from '@/components/CommandPalette';
import { IS_DEMO_PRO } from '@/lib/demoMode';
import { DEMO_BANNER_HEIGHT } from '@/components/DemoModeBanner';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

// Lazy-loaded heavy views for route-level code splitting
const DashboardView = lazy(() => import('@/components/DashboardView'));
const GanttView = lazy(() => import('@/components/GanttView'));
const AllListView = lazy(() => import('@/components/AllListView'));
const SystemAdminView = lazy(() => import('@/components/SystemAdminView'));
const WorkReportView = lazy(() => import('@/components/WorkReportView'));
const TeamIntroView = lazy(() => import('@/components/TeamIntroView'));
const KnowledgeBaseView = lazy(() => import('@/components/KnowledgeBaseView'));
const BacklogView = lazy(() => import('@/components/BacklogView'));
const QaWorkspace = lazy(() => import('@/components/qa/QaWorkspace'));
const ReleaseWorkspaceView = lazy(() => import('@/components/releases/ReleaseWorkspaceView'));

const ViewFallback = () => (
  <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground text-sm">
    <svg className="animate-spin h-6 w-6 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
    <span>{i18n.t('common.loading')}</span>
  </div>
);

const AppContent = () => {
  const { t } = useTranslation();
  const { permissions } = useAuthContext();
  const { currentView: requestedView, setCurrentView, approvalsEnabled, featureToggles, featureTogglesReady, standupMode, selectedTask, setSelectedTask, taskDisplayMode } = useUIContext();
  const qaEnabled = featureTogglesReady && featureToggles.qa;
  const releasesEnabled = featureTogglesReady && featureToggles.releases;
  const currentView = resolveReleaseView(resolveQaView(resolveApprovalView(requestedView, approvalsEnabled), qaEnabled), releasesEnabled);
  useEffect(() => {
    if (requestedView !== currentView) setCurrentView(currentView);
  }, [requestedView, currentView, setCurrentView]);
  const { allTasks } = useTaskContext();
  const { hasFeature } = useLicense();
  const [sidePanelWidth, setSidePanelWidth] = useState(580);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobile = useIsMobile();
  const compactTaskLayout = useMediaQuery('(max-width: 1023px)');

  useEffect(() => {
    if (!isMobile) setSidebarOpen(false);
  }, [isMobile]);

  // The visual viewport also shrinks for the on-screen keyboard. Dynamic vh
  // alone does not do that in every mobile browser.
  useEffect(() => {
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty('--livo-overlay-top-offset', `${IS_DEMO_PRO ? DEMO_BANNER_HEIGHT : 0}px`);
    const updateViewport = () => {
      document.documentElement.style.setProperty('--livo-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
      document.documentElement.style.setProperty('--livo-viewport-top', `${viewport?.offsetTop ?? 0}px`);
    };
    updateViewport();
    viewport?.addEventListener('resize', updateViewport);
    viewport?.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);
    return () => {
      viewport?.removeEventListener('resize', updateViewport);
      viewport?.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
      document.documentElement.style.removeProperty('--livo-viewport-height');
      document.documentElement.style.removeProperty('--livo-viewport-top');
      document.documentElement.style.removeProperty('--livo-overlay-top-offset');
    };
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('kb')) { setSelectedTask(null); setCurrentView('knowledge-base'); }
  }, [setCurrentView, setSelectedTask]);

  useEffect(() => {
    if (qaEnabled && new URLSearchParams(window.location.search).has('qa')) { setSelectedTask(null); setCurrentView('qa'); }
  }, [qaEnabled, setCurrentView, setSelectedTask]);

  useEffect(() => {
    const openRelease = () => { if (releasesEnabled && new URLSearchParams(window.location.search).has('release')) { setSelectedTask(null); setCurrentView('releases'); } };
    openRelease(); window.addEventListener('popstate', openRelease);
    return () => window.removeEventListener('popstate', openRelease);
  }, [releasesEnabled, setCurrentView, setSelectedTask]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('knowledge')) {
      setSelectedTask(null); setCurrentView('knowledge-base');
    }
  }, [setCurrentView, setSelectedTask]);

  // A shared task link (?task=KEY) opens once, after the tasks load. Later ?task
  // changes come from the history (useTaskHistory), not from here.
  const deepLinkTask = useRef(new URLSearchParams(window.location.search).get('task'));
  useEffect(() => {
    const taskKey = deepLinkTask.current;
    if (!taskKey || allTasks.length === 0) return;
    deepLinkTask.current = null;
    const url = new URL(window.location.href);
    url.searchParams.delete('task');
    window.history.replaceState({}, '', url.toString());
    const found = allTasks.find(t => t.taskKey === taskKey || t.id === taskKey);
    // Opening adds the history entry, so Back returns to the app instead of leaving it.
    if (found) setSelectedTask(found);
    // Say so instead of opening nothing; the link stays out of the address so a reload does not repeat it.
    else toast.error(t('task.linkNotFound', { key: taskKey }));
  }, [allTasks, setSelectedTask, t]);
  useTaskHistory(selectedTask, setSelectedTask, allTasks);
  const [isResizing, setIsResizing] = useState(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = sidePanelWidth;
    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const newWidth = Math.min(Math.max(startWidth + delta, 400), 1000);
      setSidePanelWidth(newWidth);
    };
    const onMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [sidePanelWidth]);

  const showSidePanel = selectedTask && taskDisplayMode === 'side' && !compactTaskLayout;
  const showFullPage = selectedTask && taskDisplayMode === 'page';

  // On mobile, don't show standup panel
  const sidebarContent = standupMode && !isMobile && hasFeature('standup') ? <StandupPanel /> : <AppSidebar onNavigate={() => setSidebarOpen(false)} />;

  return (
    <div className="livo-app-shell flex h-screen min-h-0 overflow-hidden" style={{ '--livo-app-top-offset': `${IS_DEMO_PRO ? DEMO_BANNER_HEIGHT : 0}px` } as React.CSSProperties}>
      {/* Desktop sidebar */}
      {!isMobile && sidebarContent}

      {/* Mobile sidebar overlay */}
      {isMobile && (
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" aria-describedby={undefined} className="w-[min(320px,calc(100vw-32px))] max-w-none p-0" style={{ top: IS_DEMO_PRO ? DEMO_BANNER_HEIGHT : 0 }} onCloseAutoFocus={event => {
            event.preventDefault();
            if (!document.activeElement?.closest('[role="dialog"]')) document.getElementById('livo-navigation-toggle')?.focus();
          }}>
            <SheetTitle className="sr-only">{t('sidebar.navigation')}</SheetTitle>
            {sidebarContent}
          </SheetContent>
        </Sheet>
      )}

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <TopBar onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        {showFullPage ? (
          <div className="flex-1 min-h-0 overflow-auto overscroll-contain">
            <TaskDetailContent onClose={() => setSelectedTask(null)} />
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex overflow-hidden">
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col min-w-0">
              {SCOPED_VIEWS.includes(currentView) && <ProjectScopeBar />}
              {currentView === 'board' && <BoardView />}
              {currentView === 'backlog' && <Suspense fallback={<ViewFallback />}><BacklogView /></Suspense>}
              {currentView === 'all-list' && <Suspense fallback={<ViewFallback />}><AllListView /></Suspense>}
              {currentView === 'dashboard' && (hasFeature('dashboard') ? <Suspense fallback={<ViewFallback />}><DashboardView /></Suspense> : <UpgradePrompt feature="dashboard" />)}
              {currentView === 'gantt' && <Suspense fallback={<ViewFallback />}><GanttView /></Suspense>}
              {currentView === 'team-manage' && permissions.canViewMemberList && <TeamManageView />}
              {currentView === 'status-manage' && permissions.canViewMemberList && <TeamManageView initialTab="task-config" />}
              {currentView === 'template-manage' && permissions.canViewMemberList && <TeamManageView initialTab="task-config" />}
              {currentView === 'system-admin' && permissions.canManageMembers && <Suspense fallback={<ViewFallback />}><SystemAdminView /></Suspense>}
              {currentView === 'team-intro' && <Suspense fallback={<ViewFallback />}><TeamIntroView /></Suspense>}
              {currentView === 'knowledge-base' && <Suspense fallback={<ViewFallback />}><KnowledgeBaseView /></Suspense>}
              {currentView === 'releases' && <Suspense fallback={<ViewFallback />}><ReleaseWorkspaceView /></Suspense>}
              {currentView === 'activity-log' && (hasFeature('activity-log') ? <ActivityLogView /> : <UpgradePrompt feature="activity-log" />)}
              {currentView === 'my-settings' && <MySettingsView />}
              {currentView === 'my-tasks' && <MyTasksView />}
              {qaEnabled && (currentView === 'qa' || currentView === 'my-qa') && <Suspense fallback={<ViewFallback />}><QaWorkspace mine={currentView === 'my-qa'} /></Suspense>}
              {currentView === 'work-report' && (hasFeature('work-report') ? <Suspense fallback={<ViewFallback />}><WorkReportView /></Suspense> : <UpgradePrompt feature="work-report" />)}
              {currentView === 'approvals' && (
                <div className="flex-1 min-h-0 overflow-auto p-3 md:p-6">
                  <h2 className="text-xl font-bold text-foreground mb-4">{i18n.t('approval.pending')}</h2>
                  <PendingApprovalList />
                </div>
              )}
            </div>

            {/* Side panel for task detail */}
            {showSidePanel && (
              <div className="flex shrink-0" style={{ width: sidePanelWidth }}>
                <div
                  className="w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
                  onMouseDown={handleMouseDown}
                />
                <div className="flex-1 overflow-auto border-l">
                  <TaskDetailContent onClose={() => setSelectedTask(null)} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modals */}
      <CreateProjectModal />
      <CreateTaskModal />
      {selectedTask && taskDisplayMode === 'modal' && (
        <TaskDetailModal onClose={() => setSelectedTask(null)} />
      )}
      <CommandPalette />
      <OnboardingGuide />
    </div>
  );
};

const Index = () => (
  <ErrorBoundary>
    <AppProvider>
      <LicenseProvider>
        <UndoStackProvider>
          <NotificationToastProvider>
            <MyAssignmentsProvider><AppContent /></MyAssignmentsProvider>
          </NotificationToastProvider>
        </UndoStackProvider>
      </LicenseProvider>
    </AppProvider>
  </ErrorBoundary>
);

export default Index;
