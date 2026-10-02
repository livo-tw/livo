import { useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { AppProvider } from '@/context/AppContext';
import { useAuthContext } from '@/context/AuthContext';
import { resolveApprovalView, resolveQaView } from '@/lib/featureToggles';
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
import MyTasksView from '@/components/MyTasksView';
import MySettingsView from '@/components/MySettingsView';
import TeamManageView from '@/components/TeamManageView';
import PendingApprovalList from '@/components/approval/PendingApprovalList';
import { NotificationToastProvider } from '@/components/notifications/NotificationToastProvider';
import { useIsMobile } from '@/hooks/use-mobile';
import ErrorBoundary from '@/components/ErrorBoundary';
import CommandPalette from '@/components/CommandPalette';

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
  const { permissions } = useAuthContext();
  const { currentView: requestedView, setCurrentView, approvalsEnabled, featureToggles, featureTogglesReady, standupMode, selectedTask, setSelectedTask, taskDisplayMode, setTaskDisplayMode } = useUIContext();
  const qaEnabled = featureTogglesReady && featureToggles.qa;
  const currentView = resolveQaView(resolveApprovalView(requestedView, approvalsEnabled), qaEnabled);
  useEffect(() => {
    if (requestedView !== currentView) setCurrentView(currentView);
  }, [requestedView, currentView, setCurrentView]);
  const { allTasks } = useTaskContext();
  const { hasFeature } = useLicense();
  const [sidePanelWidth, setSidePanelWidth] = useState(580);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (qaEnabled && new URLSearchParams(window.location.search).has('qa')) { setSelectedTask(null); setCurrentView('qa'); }
  }, [qaEnabled, setCurrentView, setSelectedTask]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const taskKey = params.get('task');
    if (taskKey && allTasks.length > 0 && !selectedTask) {
      const found = allTasks.find(t => t.taskKey === taskKey || t.id === taskKey);
      if (found) {
        setTaskDisplayMode('page');
        setSelectedTask(found);
        const url = new URL(window.location.href);
        url.searchParams.delete('task');
        window.history.replaceState({}, '', url.toString());
      }
    }
  }, [allTasks, selectedTask, setSelectedTask, setTaskDisplayMode]);
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

  // Mobile: always force page mode for tasks, no standup mode
  useEffect(() => {
    if (isMobile && selectedTask && taskDisplayMode !== 'page') {
      setTaskDisplayMode('page');
    }
  }, [isMobile, selectedTask, taskDisplayMode, setTaskDisplayMode]);

  const showSidePanel = selectedTask && taskDisplayMode === 'side' && !isMobile;
  const showFullPage = selectedTask && taskDisplayMode === 'page';

  // On mobile, don't show standup panel
  const sidebarContent = standupMode && !isMobile && hasFeature('standup') ? <StandupPanel /> : <AppSidebar onNavigate={() => setSidebarOpen(false)} />;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      {!isMobile && sidebarContent}

      {/* Mobile sidebar overlay */}
      {isMobile && sidebarOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 w-[280px] shadow-2xl">
            {sidebarContent}
          </div>
        </>
      )}

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <TopBar onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        {showFullPage ? (
          <div className="flex-1 overflow-auto">
            <TaskDetailContent onClose={() => setSelectedTask(null)} />
          </div>
        ) : (
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 overflow-hidden flex flex-col min-w-0">
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
              {currentView === 'activity-log' && (hasFeature('activity-log') ? <ActivityLogView /> : <UpgradePrompt feature="activity-log" />)}
              {currentView === 'my-settings' && <MySettingsView />}
              {currentView === 'my-tasks' && <MyTasksView />}
              {qaEnabled && (currentView === 'qa' || currentView === 'my-qa') && <Suspense fallback={<ViewFallback />}><QaWorkspace mine={currentView === 'my-qa'} /></Suspense>}
              {currentView === 'work-report' && (hasFeature('work-report') ? <Suspense fallback={<ViewFallback />}><WorkReportView /></Suspense> : <UpgradePrompt feature="work-report" />)}
              {currentView === 'approvals' && (
                <div className="flex-1 overflow-auto p-6">
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
            <AppContent />
          </NotificationToastProvider>
        </UndoStackProvider>
      </LicenseProvider>
    </AppProvider>
  </ErrorBoundary>
);

export default Index;
