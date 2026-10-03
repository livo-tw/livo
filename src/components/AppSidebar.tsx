import { useProjectColor } from '@/hooks/useProjectColor';
import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, FolderOpen, Settings, MoreHorizontal, Pencil, Trash2, Users, Wrench, History, MessageCircle, ClipboardCheck, Bug } from 'lucide-react';
import { useAuthContext } from '@/context/AuthContext';
import { useUIContext } from '@/context/UIContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useTaskContext } from '@/context/TaskContext';
import { useLicense } from '@/context/LicenseContext';
import { logActivity } from '@/lib/activityLog';

import { useConfirmDialog } from '@/components/ConfirmDialog';
import StandupLaunchDialog from '@/components/StandupLaunchDialog';
import UpgradePrompt from '@/components/UpgradePrompt';

interface AppSidebarProps {
  onNavigate?: () => void;
}

const AppSidebar = ({ onNavigate }: AppSidebarProps) => {
  const { t } = useTranslation();
  const getProjectColor = useProjectColor();
  const { permissions, currentMember, currentMemberId } = useAuthContext();
  const { approvalsEnabled, featureToggles, featureTogglesReady, setCurrentView, currentView, setShowCreateProject, setEditingProject, setSelectedTask, setStandupMode } = useUIContext();
  const { selectedProjectId, setSelectedProjectId, selectedLineId, setSelectedLineId, allProjects, productLines, deleteProjectInDb } = useProjectContext();
  const { allTasks } = useTaskContext();
  const { hasFeature } = useLicense();
  const [expandedLines, setExpandedLines] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);

  const [showStandupLaunch, setShowStandupLaunch] = useState(false);
  const [showStandupUpgrade, setShowStandupUpgrade] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { confirm, ConfirmDialog } = useConfirmDialog();

  useEffect(() => {
    if (productLines.length > 0 && expandedLines.length === 0) {
      setExpandedLines(productLines.map(l => l.id));
    }
  }, [productLines]);

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    if (contextMenu) document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [contextMenu]);

  const toggleLine = (lineId: string) => {
    setExpandedLines(prev =>
      prev.includes(lineId) ? prev.filter(id => id !== lineId) : [...prev, lineId]
    );
  };

  const taskCountByProject = useMemo(() => {
    const map = new Map<string, number>();
    allTasks.forEach(t => map.set(t.projectId, (map.get(t.projectId) || 0) + 1));
    return map;
  }, [allTasks]);

  const getProjectTaskCount = (projectId: string) => taskCountByProject.get(projectId) || 0;
  const getLineTaskCount = (lineId: string) => {
    return allProjects.filter(p => p.lineId === lineId).reduce((sum, p) => sum + (taskCountByProject.get(p.id) || 0), 0);
  };
  const totalTaskCount = allTasks.length;

  const handleContextMenu = (e: React.MouseEvent, projectId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const menuW = 160;
    const menuH = 96;
    const x = Math.min(e.clientX, window.innerWidth - menuW - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuH - 8);
    setContextMenu({ projectId, x, y });
  };

  const handleEdit = () => {
    if (!contextMenu) return;
    const project = allProjects.find(p => p.id === contextMenu.projectId);
    if (project) {
      setEditingProject(project);
      setShowCreateProject(true);
    }
    setContextMenu(null);
  };

  const handleDelete = async () => {
    if (!contextMenu) return;
    const project = allProjects.find(p => p.id === contextMenu.projectId);
    if (!project) return;
    const taskCount = getProjectTaskCount(project.id);
    const msg = taskCount > 0
      ? t('project.deleteConfirmWithTasks', { name: project.name, count: taskCount })
      : t('project.deleteConfirm', { name: project.name });
    if (!(await confirm({ title: t('project.deleteTitle'), description: msg, destructive: true }))) {
      setContextMenu(null);
      return;
    }
    await deleteProjectInDb(project.id);
    setContextMenu(null);
  };

  const nav = (action: () => void) => {
    setSelectedTask(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('qa');
    window.history.replaceState({}, '', url.toString());
    window.dispatchEvent(new Event('livo:qa-navigation'));
    action();
    onNavigate?.();
  };

  return (
    <>
    <nav
      aria-label={t('sidebar.ariaLabel')}
      className="w-[240px] md:w-[240px] h-full flex flex-col flex-shrink-0 overflow-hidden border-r border-sidebar-border"
      style={{
        background: 'linear-gradient(to right, hsl(var(--sidebar-background)), hsl(var(--sidebar-gradient-end, var(--sidebar-background))))',
      }}
    >
      {/* ─── 導覽 Section ─── */}
      <div className="px-2 pt-3 pb-1">
        <div className="px-3 mb-1.5 flex items-center gap-1.5">
          <div className="w-1 h-3 rounded-full bg-sidebar-primary" />
          <span className="text-[10px] font-bold text-sidebar-foreground/50 uppercase tracking-widest">{t('sidebar.navigation')}</span>
        </div>

        {/* Team Intro */}
        <button
          onClick={() => nav(() => setCurrentView('team-intro'))}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium mb-0.5 transition-all ${
            currentView === 'team-intro'
              ? 'text-sidebar-primary-foreground font-semibold bg-sidebar-primary/90 shadow-sm'
              : 'text-sidebar-foreground hover:bg-sidebar-hover'
          }`}
        >
          <Users size={16} />
          {t('sidebar.teamIntro')}
        </button>

        <button onClick={() => nav(() => { setSelectedProjectId(null); setSelectedLineId(null); setCurrentView('knowledge-base'); })}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium mb-0.5 transition-all ${currentView === 'knowledge-base' ? 'text-sidebar-primary-foreground bg-sidebar-primary/90 shadow-sm' : 'text-sidebar-foreground hover:bg-sidebar-hover'}`}>
          <FolderOpen size={16} />{t('kb.title')}
        </button>

        {/* All Tasks */}
        {featureTogglesReady && featureToggles.qa && <>
          <button onClick={() => nav(() => { setSelectedProjectId(null); setSelectedLineId(null); setCurrentView('qa'); })} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium ${currentView === 'qa' ? 'bg-sidebar-primary/90 text-sidebar-primary-foreground' : 'text-sidebar-foreground hover:bg-sidebar-hover'}`}><Bug size={16} />{t('qa.title')}</button>
          <button onClick={() => nav(() => { setSelectedProjectId(null); setSelectedLineId(null); setCurrentView('my-qa'); })} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium ${currentView === 'my-qa' ? 'bg-sidebar-primary/90 text-sidebar-primary-foreground' : 'text-sidebar-foreground hover:bg-sidebar-hover'}`}><ClipboardCheck size={16} />{t('qa.myTitle')}</button>
          {selectedProjectId && <button onClick={() => nav(() => setCurrentView('qa'))} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-hover"><Bug size={16} />{t('qa.projectEntry')} · {allProjects.find(p => p.id === selectedProjectId)?.name}</button>}
        </>}
        <button
          onClick={() => nav(() => {
            setSelectedProjectId(null);
            setSelectedLineId(null);
            if (!['board', 'all-list', 'my-tasks', 'gantt', 'backlog'].includes(currentView)) {
              setCurrentView('board');
            }
          })}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-all ${
            selectedProjectId === null && selectedLineId === null && !['qa', 'my-qa', 'knowledge-base', 'status-manage', 'team-manage', 'team-intro', 'system-admin', 'activity-log', 'my-settings', 'template-manage', 'work-report', 'approvals', 'backlog'].includes(currentView)
              ? 'text-sidebar-primary-foreground font-semibold bg-sidebar-primary/90 shadow-sm'
              : 'text-sidebar-foreground hover:bg-sidebar-hover'
          }`}
        >
          <span className="flex items-center gap-2.5">
            <FolderOpen size={16} />
            {t('sidebar.allTasks')}
          </span>
          <span className="text-sidebar-foreground/40 text-xs font-medium bg-sidebar-accent/50 px-1.5 py-0.5 rounded">{totalTaskCount}</span>
        </button>
        {/* Standup */}
        <button
          onClick={() => {
            setSelectedTask(null);
            if (!hasFeature('standup')) { setShowStandupUpgrade(true); return; }
            setShowStandupLaunch(true);
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium mb-0.5 transition-all text-sidebar-foreground hover:bg-sidebar-hover"
        >
          <MessageCircle size={16} />
          {t('sidebar.standup')}
        </button>

        {/* Approvals */}
        {approvalsEnabled && <button
          onClick={() => nav(() => setCurrentView('approvals'))}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium mb-0.5 transition-all ${
            currentView === 'approvals'
              ? 'text-sidebar-primary-foreground font-semibold bg-sidebar-primary/90 shadow-sm'
              : 'text-sidebar-foreground hover:bg-sidebar-hover'
          }`}
        >
          <ClipboardCheck size={16} />
          {t('sidebar.approvals')}
        </button>}
      </div>

      {/* ─── 專案 Section (main scrollable area) ─── */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        <div className="px-3 mt-2 mb-1.5 flex items-center gap-1.5">
          <div className="w-1 h-3 rounded-full bg-sidebar-foreground/30" />
          <span className="text-[10px] font-bold text-sidebar-foreground/40 uppercase tracking-widest">{t('sidebar.projects')}</span>
        </div>

        {productLines.map(line => {
          const lineProjects = allProjects.filter(p => p.lineId === line.id && !p.isArchived);
          const isExpanded = expandedLines.includes(line.id);

          return (
            <div key={line.id} className="mb-0.5">
              <div className={`flex items-center rounded text-sm transition-colors ${
                selectedLineId === line.id && !selectedProjectId
                  ? 'bg-sidebar-active text-sidebar-primary-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-hover'
              }`}>
                <button
                  onClick={(e) => { e.stopPropagation(); toggleLine(line.id); }}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? `${t('sidebar.collapse')} ${line.name}` : `${t('sidebar.expand')} ${line.name}`}
                  className="px-1.5 py-1.5 hover:text-sidebar-primary-foreground flex-shrink-0"
                >
                  {isExpanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                </button>
                <button
                  onClick={() => nav(() => {
                    setSelectedLineId(line.id);
                    setSelectedProjectId(null);
                    if (!['board', 'all-list', 'my-tasks', 'gantt', 'backlog'].includes(currentView)) {
                      setCurrentView('board');
                    }
                  })}
                  className="flex-1 flex items-center justify-between py-1.5 pr-3"
                >
                  <span className="flex items-center gap-1.5">
                    <span>{line.icon}</span>
                    <span className="font-medium">{line.name}</span>
                  </span>
                  <span className="text-sidebar-foreground/50 text-xs">{getLineTaskCount(line.id)}</span>
                </button>
              </div>
              {isExpanded && (
                <div className="ml-3 space-y-0.5 mt-0.5">
                  {lineProjects.map(project => (
                    <button
                      key={project.id}
                      onClick={() => nav(() => {
                        setSelectedProjectId(project.id);
                        setSelectedLineId(null);
                        if (!['board', 'all-list', 'my-tasks', 'gantt', 'backlog'].includes(currentView)) {
                          setCurrentView('board');
                        }
                      })}
                      onContextMenu={(e) => (permissions.canEditProject || permissions.canDeleteProject) ? handleContextMenu(e, project.id) : undefined}
                      className={`w-full flex items-center justify-between px-3 py-1.5 rounded text-sm transition-colors group ${
                        selectedProjectId === project.id
                          ? 'bg-sidebar-active text-sidebar-primary-foreground'
                          : 'text-sidebar-foreground hover:bg-sidebar-hover'
                      }`}
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: getProjectColor(project) }} />
                        <span className="truncate">{project.name}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-sidebar-foreground/50 text-xs">{getProjectTaskCount(project.id)}</span>
                        {(permissions.canEditProject || permissions.canDeleteProject) && (
                          <span
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-sidebar-hover"
                            onClick={(e) => { e.stopPropagation(); handleContextMenu(e, project.id); }}
                          >
                            <MoreHorizontal size={14} className="text-sidebar-foreground/50" />
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ─── 管理 Section (bottom, grouped) ─── */}
      <div className="px-2 py-2 border-t border-sidebar-border space-y-3">

        {/* 專案管理 group */}
        <div>
          <div className="px-3 pt-0.5 pb-1 flex items-center gap-1.5">
            <div className="w-1 h-2.5 rounded-full bg-sidebar-foreground/20" />
            <span className="text-[9px] font-bold text-sidebar-foreground/40 uppercase tracking-widest">{t('sidebar.projectManagement')}</span>
          </div>
          <div className="space-y-0.5">
            <button
              onClick={() => { setShowCreateProject(true); onNavigate?.(); }}
              className="w-full text-left text-sm text-sidebar-foreground/70 hover:text-sidebar-foreground px-3 py-1.5 rounded-lg hover:bg-sidebar-hover transition-all font-medium"
            >
              {t('sidebar.createProject')}
            </button>
          </div>
        </div>

        {/* 團隊管理 group */}
        {permissions.canViewMemberList && (
          <div>
            <div className="px-3 pb-1 flex items-center gap-1.5">
              <div className="w-1 h-2.5 rounded-full bg-sidebar-foreground/20" />
              <span className="text-[9px] font-bold text-sidebar-foreground/40 uppercase tracking-widest">{t('sidebar.teamManagement')}</span>
            </div>
            <div className="space-y-0.5">
              <button
                onClick={() => nav(() => setCurrentView('team-manage'))}
                title={t('sidebar.teamSettingsHint')}
                className={`w-full flex items-center gap-2 text-sm px-3 py-1.5 rounded transition-colors ${
                  ['team-manage', 'status-manage', 'template-manage'].includes(currentView) ? 'bg-sidebar-active/20 text-primary font-semibold' : 'text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar-hover'
                }`}
              >
                <Settings size={14} />
                {t('sidebar.teamManage')}
              </button>
              {currentMember?.role === 'super_admin' && (
                <button
                  onClick={() => nav(() => setCurrentView('activity-log'))}
                  className={`w-full flex items-center gap-2 text-sm px-3 py-1.5 rounded transition-colors ${
                    currentView === 'activity-log' ? 'bg-sidebar-active/20 text-primary font-semibold' : 'text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar-hover'
                  }`}
                >
                  <History size={14} />
                  {t('sidebar.activityLog')}
                </button>
              )}
            </div>
          </div>
        )}

        {/* 系統設定 group (super_admin only) */}
        {permissions.canManageMembers && (
          <div>
            <div className="px-3 pb-1 flex items-center gap-1.5">
              <div className="w-1 h-2.5 rounded-full bg-sidebar-foreground/20" />
              <span className="text-[9px] font-bold text-sidebar-foreground/40 uppercase tracking-widest">{t('sidebar.systemSettings')}</span>
            </div>
            <div className="space-y-0.5">
              <button
                onClick={() => nav(() => setCurrentView('system-admin'))}
                title={t('sidebar.systemAdminHint')}
                className={`w-full flex items-center gap-2 text-sm px-3 py-1.5 rounded transition-colors ${
                  currentView === 'system-admin' ? 'bg-sidebar-active/20 text-primary font-semibold' : 'text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar-hover'
                }`}
              >
                <Wrench size={14} />
                {t('sidebar.systemAdmin')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {permissions.canEditProject && (
            <button
              onClick={handleEdit}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent transition-colors"
            >
              <Pencil size={14} />
              {t('common.edit')}
            </button>
          )}
          {permissions.canDeleteProject && (
            <button
              onClick={handleDelete}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-accent transition-colors"
            >
              <Trash2 size={14} />
              {t('common.delete')}
            </button>
          )}
        </div>
      )}
    </nav>

    {/* Modals */}
    <StandupLaunchDialog
      open={showStandupLaunch}
      onOpenChange={setShowStandupLaunch}
      onConfirm={() => {
        setShowStandupLaunch(false);
        setSelectedProjectId(null);
        setSelectedLineId(null);
        setCurrentView('board');
        setStandupMode(true);
        if (currentMemberId) logActivity(currentMemberId, 'start_standup', 'Start standup', undefined, undefined, 'system');
        onNavigate?.();
      }}
    />
    {showStandupUpgrade && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        onClick={() => setShowStandupUpgrade(false)}
      >
        <div
          className="bg-card rounded-xl shadow-xl border border-border w-full max-w-md max-h-[90vh] overflow-auto"
          onClick={e => e.stopPropagation()}
        >
          <UpgradePrompt feature="standup" />
        </div>
      </div>
    )}
    {ConfirmDialog}
    </>
  );
};

export default AppSidebar;
