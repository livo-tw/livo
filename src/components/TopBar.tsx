import { SearchableSelect } from '@/components/ui/searchable-select';
import { useAuthContext } from '@/context/AuthContext';
import { useMemberContext } from '@/context/MemberContext';
import { useUIContext } from '@/context/UIContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useTaskContext } from '@/context/TaskContext';
import { useLicense } from '@/context/LicenseContext';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard, BarChart3, CalendarDays, LogOut, Table2, X, Search, Menu, User, Settings, FileText, ClipboardCheck, Inbox, Bug, Plus, BookOpen } from 'lucide-react';
import NotificationPanel from '@/components/NotificationPanel';
import { MyAssignmentsDropdown } from '@/components/MyAssignments';
import PendingApprovalList from '@/components/approval/PendingApprovalList';
import { useActionableApprovalCount } from '@/hooks/useActionableApprovalCount';
import { supabase } from '@/integrations/supabase/client';
import { useState, useRef, useEffect, useMemo } from 'react';
import { getRoleLabel, getRoleColor, type MemberRole } from '@/lib/permissions';
import { useIsMobile } from '@/hooks/use-mobile';
import { IS_DEMO_PRO } from '@/lib/demoMode';

const navItemDefs = [
  { id: 'dashboard' as const, labelKey: 'nav.dashboard', icon: BarChart3 },
  { id: 'gantt' as const, labelKey: 'nav.gantt', icon: CalendarDays },
  { id: 'board' as const, labelKey: 'nav.board', icon: LayoutDashboard },
  { id: 'backlog' as const, labelKey: 'nav.backlog', icon: Inbox },
  { id: 'all-list' as const, labelKey: 'nav.list', icon: Table2 },
  { id: 'my-tasks' as const, labelKey: 'nav.myTasks', icon: User },
  { id: 'knowledge-base' as const, labelKey: 'kb.title', icon: BookOpen },
  { id: 'qa' as const, labelKey: 'qa.title', icon: Bug },
  // Work report always stays the last (rightmost) tab.
  { id: 'work-report' as const, labelKey: 'nav.workReport', icon: FileText },
];

interface TopBarProps {
  onToggleSidebar?: () => void;
}

const TopBar = ({ onToggleSidebar }: TopBarProps) => {
  const { t } = useTranslation();
  const { currentMember, currentMemberId, setCurrentMemberId, realMember } = useAuthContext();
  const { users } = useMemberContext();
  const { approvalsEnabled, featureToggles, featureTogglesReady, setShowCreateTask, setCurrentView, currentView, selectedTask, setSelectedTask, taskDisplayMode } = useUIContext();
  const qaEnabled = featureTogglesReady && featureToggles.qa;
  const qaView = qaEnabled && (currentView === 'qa' || currentView === 'my-qa');
  const createItem = () => {
    if (!qaView) { setShowCreateTask(true); return; }
    setSelectedTask(null);
    const url = new URL(window.location.href); url.searchParams.delete('qa'); url.searchParams.set('qaCreate', '1');
    window.history.replaceState({}, '', url.toString()); window.dispatchEvent(new Event('livo:qa-create'));
  };
  const { setSelectedProjectId, setSelectedLineId } = useProjectContext();
  const { allTasks, statuses, taskSpecs } = useTaskContext();
  const { hasFeature } = useLicense();
  const isMobile = useIsMobile();
  const [showMenu, setShowMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [showPendingApprovals, setShowPendingApprovals] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const approvalPanelRef = useRef<HTMLDivElement>(null);

  // The badge counts what this member can act on, like the list it opens; it is
  // re-read when any task's approval state changes and when the list closes.
  const workspacePendingCount = allTasks.filter(t => t.approvalStatus === 'pending_approval').length;
  const pendingApprovalCount = useActionableApprovalCount(approvalsEnabled && featureTogglesReady, `${workspacePendingCount}:${showPendingApprovals}`) ?? 0;

  // Role hierarchy: super_admin > admin > member
  const roleLevel = (role: string) => role === 'super_admin' ? 3 : role === 'admin' ? 2 : 1;
  const realRole = realMember?.role || 'member';
  const realLevel = roleLevel(realRole);
  // Identity switching exists only in the ?demo=pro showcase, so visitors can
  // try each role. On a real install it would let an admin act and post as
  // someone else, so it is never offered there.
  const canSwitch = IS_DEMO_PRO && realLevel >= 2; // admin or super_admin
  const switchableUsers = canSwitch
    ? users.filter(u => roleLevel(u.role) < realLevel || u.id === realMember?.id)
    : users.filter(u => u.id === realMember?.id);

  const specMap = useMemo(() => {
    const map = new Map<string, string>();
    taskSpecs.forEach(spec => {
      const text = [spec.background, spec.requirement, spec.notes]
        .filter(Boolean)
        .join(' ')
        .replace(/<[^>]*>/g, '');
      map.set(spec.taskId, text.toLowerCase());
    });
    return map;
  }, [taskSpecs]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return allTasks.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.taskKey.toLowerCase().includes(q) ||
      (specMap.get(t.id) ?? '').includes(q)
    ).slice(0, 15);
  }, [searchQuery, allTasks, specMap]);

  const handleSelectSearchResult = (task: typeof allTasks[0]) => {
    setSelectedTask(task);
    setSearchQuery('');
    setSearchFocused(false);
    setMobileSearchOpen(false);
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchFocused(false);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, []);

  const handleLogout = async () => {
    window.dispatchEvent(new Event('livo:qa-abort'));
    await supabase.auth.signOut();
  };

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
      if (approvalPanelRef.current && !approvalPanelRef.current.contains(e.target as Node)) {
        setShowPendingApprovals(false);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, []);

  const searchDropdown = searchFocused && searchQuery.trim() && (
    <div className="absolute top-full mt-1 left-0 right-0 bg-card border border-border rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto">
      {searchResults.length === 0 ? (
        <div className="px-4 py-3 text-sm text-muted-foreground text-center">{t('search.noResults')}</div>
      ) : (
        searchResults.map(task => {
          const status = statuses.find(s => s.id === task.statusId);
          return (
            <button
              key={task.id}
              onClick={() => handleSelectSearchResult(task)}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-accent transition-colors border-b border-border last:border-b-0"
            >
              <span className="text-xs font-mono text-muted-foreground flex-shrink-0">{task.taskKey}</span>
              <span className="text-sm text-foreground truncate flex-1">{task.title}</span>
              {status && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full text-white flex-shrink-0" style={{ backgroundColor: status.color }}>
                  {status.name}
                </span>
              )}
            </button>
          );
        })
      )}
    </div>
  );

  return (
    <div className="relative flex-shrink-0 shadow-md" style={{
      background: 'linear-gradient(to bottom, hsl(var(--sidebar-background)), hsl(var(--tab-bar-bg, var(--sidebar-accent))))',
    }}>
      {/* Row 1: Logo + Search + Actions */}
      <div className="h-14 flex items-center justify-between px-3 md:px-4 gap-2">
        <div className="flex items-center gap-2 flex-shrink-0">
          {isMobile && (
            <button onClick={onToggleSidebar} aria-label={t('sidebar.navigation')} className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-md text-sidebar-foreground hover:bg-sidebar-hover transition-colors">
              <Menu size={20} aria-hidden="true" />
            </button>
          )}
          <img
            src={`${import.meta.env.BASE_URL}livo-logo.png`}
            alt="LIVO"
            className="h-16 w-auto cursor-pointer hover:opacity-80 transition-opacity select-none"
            style={{ filter: 'var(--sidebar-logo-filter)' }}
            onClick={() => { setSelectedProjectId(null); setSelectedLineId(null); setSelectedTask(null); setCurrentView('board'); }}
          />
        </div>

        {/* Desktop search + create */}
        {!isMobile && (
          <div className="flex-1 flex items-center justify-center gap-2 mx-6">
            <div className="relative w-full max-w-sm" ref={searchRef}>
              <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-sidebar-accent/60 text-sidebar-foreground text-sm w-full">
                <Search size={14} className="text-sidebar-foreground/50 flex-shrink-0" />
                <input
                  type="text"
                  placeholder={t('search.placeholder')}
                  aria-label={t('search.placeholder')}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onFocus={() => setSearchFocused(true)}
                  className="bg-transparent outline-none text-sm text-sidebar-foreground placeholder:text-sidebar-foreground/50 w-full"
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} aria-label={t('search.clear')} className="text-sidebar-foreground/50 hover:text-sidebar-foreground">
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
              {searchDropdown}
            </div>
            <button
              onClick={createItem}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-sm hover:shadow-md flex-shrink-0"
            >
              {qaView ? `+ ${t('qa.report')}` : t('button.createAction')}
            </button>
          </div>
        )}

        {/* Right side actions */}
        <div className="flex items-center gap-1.5 md:gap-2 flex-shrink-0">
          {/* Mobile search toggle */}
          {isMobile && (
            <button
              onClick={() => setMobileSearchOpen(!mobileSearchOpen)}
              aria-label={t('common.search')}
              aria-expanded={mobileSearchOpen}
              className="absolute left-3 top-14 flex items-center justify-center min-w-[44px] min-h-[44px] rounded text-sidebar-foreground hover:bg-sidebar-hover transition-colors"
            >
              <Search size={18} aria-hidden="true" />
            </button>
          )}

          {/* Mobile create button */}
          {isMobile && (
            <button
              onClick={createItem}
              aria-label={t(qaView ? 'qa.report' : 'button.createAction')}
              title={t(qaView ? 'qa.report' : 'button.createAction')}
              className="absolute left-14 top-14 flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Plus size={18} aria-hidden="true" />
            </button>
          )}

          {/* Pending approvals button */}
          {approvalsEnabled && <div className={isMobile ? 'absolute left-[100px] top-14' : 'relative'} ref={approvalPanelRef}>
            <button
              onClick={() => setShowPendingApprovals(v => !v)}
              aria-label={t('approval.pending')}
              className="relative flex items-center justify-center min-w-[44px] min-h-[44px] md:min-w-[36px] md:min-h-[36px] rounded text-sidebar-foreground hover:bg-sidebar-hover transition-colors"
            >
              <ClipboardCheck size={18} aria-hidden="true" />
              {pendingApprovalCount > 0 && (
                <span className="absolute top-0.5 right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-purple-600 text-white text-[9px] font-bold px-0.5">
                  {pendingApprovalCount > 9 ? '9+' : pendingApprovalCount}
                </span>
              )}
            </button>
            {showPendingApprovals && (
              <>
                <div onClick={() => setShowPendingApprovals(false)} className="md:hidden fixed inset-0 z-[99] bg-black/40 backdrop-blur-[2px]" aria-hidden="true" />
                <div className="z-[100] bg-card border border-border shadow-xl overflow-hidden flex flex-col fixed inset-x-0 top-14 bottom-0 rounded-t-xl md:absolute md:inset-auto md:right-0 md:top-10 md:bottom-auto md:w-[400px] md:max-w-[calc(100vw-16px)] md:max-h-[480px] md:rounded-lg">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
                    <h3 className="text-base font-bold text-foreground">{t('approval.pendingItems')}</h3>
                    <button onClick={() => setShowPendingApprovals(false)} aria-label={t('common.close')} className="text-muted-foreground hover:text-foreground">
                      <X size={14} />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3 md:p-3">
                    <PendingApprovalList onClose={() => setShowPendingApprovals(false)} />
                  </div>
                </div>
              </>
            )}
          </div>}

          <MyAssignmentsDropdown />
          <NotificationPanel />

          {/* Current member selector - only for admin/super_admin, hidden on mobile */}
          {!isMobile && canSwitch && hasFeature('proxy-login') && (
            <SearchableSelect
              value={currentMemberId}
              onChange={e => setCurrentMemberId(e.target.value)}
              className="bg-sidebar-accent/60 text-sidebar-foreground text-xs rounded px-2 py-1.5 border-0 outline-none"
            >
              {switchableUsers.map(u => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </SearchableSelect>
          )}

          {/* User avatar with dropdown */}
          <div className="relative" ref={menuRef}>
            <div className="flex shrink-0 items-center gap-1.5 cursor-pointer" onClick={() => setShowMenu(!showMenu)}>
              <div
                className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
                style={{ backgroundColor: currentMember?.color || '#0065FF' }}
              >
                {currentMember?.avatar || '?'}
              </div>
              {!isMobile && currentMember && (
                <span
                  className="shrink-0 whitespace-nowrap text-[10px] leading-4 px-1.5 py-0.5 rounded-full font-medium text-white"
                  style={{ backgroundColor: getRoleColor(currentMember.role as MemberRole) }}
                >
                  {getRoleLabel(currentMember.role as MemberRole)}
                </span>
              )}
            </div>
            {showMenu && (
              <div className="absolute right-0 top-10 z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[160px]">
                {/* Mobile-only: member selector - only for admin/super_admin */}
                {isMobile && canSwitch && hasFeature('proxy-login') && (
                  <div className="px-3 py-2 border-b border-border">
                    <label className="text-xs text-muted-foreground block mb-1">{t('auth.switchIdentity')}</label>
                    <SearchableSelect
                      value={currentMemberId}
                      onChange={e => { setCurrentMemberId(e.target.value); setShowMenu(false); }}
                      className="w-full bg-muted text-foreground text-xs rounded px-2 py-1.5 border-0 outline-none"
                    >
                      {switchableUsers.map(u => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </SearchableSelect>
                  </div>
                )}
                <button
                  onClick={() => { setShowMenu(false); setCurrentView('my-settings'); }}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-foreground hover:bg-accent transition-colors"
                >
                  <Settings size={14} />
                  {t('nav.personalSettings')}
                </button>
                <button
                  onClick={() => { setShowMenu(false); handleLogout(); }}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-destructive hover:bg-accent transition-colors"
                >
                  <LogOut size={14} />
                  {t('auth.logout')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Mobile search bar (expandable) */}
      {isMobile && mobileSearchOpen && (
        <div className="px-3 pb-2" ref={searchRef}>
          <div className="relative">
            <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-sidebar-accent/60 text-sidebar-foreground text-sm w-full">
              <Search size={14} className="text-sidebar-foreground/50 flex-shrink-0" />
              <input
                type="text"
                placeholder={t('search.placeholder')}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                autoFocus
                className="bg-transparent outline-none text-sm text-sidebar-foreground placeholder:text-sidebar-foreground/50 w-full"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="text-sidebar-foreground/50 hover:text-sidebar-foreground">
                  <X size={14} />
                </button>
              )}
              <button onClick={() => setMobileSearchOpen(false)} className="text-sidebar-foreground/50 hover:text-sidebar-foreground">
                <X size={14} />
              </button>
            </div>
            {searchFocused && searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto z-50">
                {searchResults.map(task => (
                  <button
                    key={task.id}
                    onClick={() => { setSelectedTask(task); setSearchQuery(''); setSearchFocused(false); setMobileSearchOpen(false); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors border-b border-border/50 last:border-0"
                  >
                    <span className="font-medium text-foreground">{task.taskKey}</span>
                    <span className="text-muted-foreground ml-2">{task.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Row 2: Nav tabs — aligned with search bar center on desktop, horizontal scroll on mobile */}
      <div className={`flex min-h-[52px] items-center pr-3 md:min-h-0 md:px-4 pb-2 gap-2 ${approvalsEnabled ? 'pl-[150px]' : 'pl-[106px]'}`}>
        {/* Spacer matching logo width — desktop only */}
        <div className="hidden md:block flex-shrink-0 invisible">
          <img className="h-16 w-auto" src="" alt="" />
        </div>
        {/* Tabs scroll when they do not fit. Centred with auto margins, not justify-center,
            so a row wider than the space starts at its first tab instead of clipping it. */}
        <div className="flex-1 flex items-center justify-start md:mx-6 overflow-x-auto scrollbar-hide">
          <div className="flex items-center gap-1 min-w-min md:mx-auto">
            {navItemDefs
              .filter(item => !(item.id === 'work-report' && !hasFeature('work-report')))
              .filter(item => item.id !== 'qa' || qaEnabled)
              .map(item => {
                const Icon = item.icon;
                const isActive = currentView === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => { if (selectedTask && taskDisplayMode === 'page') setSelectedTask(null); const url = new URL(window.location.href); url.searchParams.delete('qa'); url.searchParams.delete('qaCreate'); url.searchParams.delete('release'); window.history.replaceState({}, '', url.toString()); window.dispatchEvent(new Event('livo:qa-navigation')); setCurrentView(item.id); }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-foreground'
                        : 'text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50'
                    }`}
                  >
                    <Icon size={14} />
                    {t(item.labelKey)}
                  </button>
                );
              })}
          </div>
        </div>
        {/* Spacer matching right actions width — desktop only */}
        <div className="hidden md:block flex-shrink-0 invisible">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9" />
            <div className="w-9 h-9" />
            <div className="w-8 h-8" />
          </div>
        </div>
      </div>
    </div>
  );
};

export default TopBar;
