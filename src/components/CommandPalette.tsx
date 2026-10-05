import { ProjectGroupedList } from '@/components/project/ProjectOptions';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, FolderKanban, User, Plus } from 'lucide-react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command';
import { useTaskContext } from '@/context/TaskContext';
import { useProjectContext } from '@/context/ProjectContext';
import { scopeChangeBlocked, viewAfterScopeChange } from '@/hooks/useProjectScope';
import { useMemberContext } from '@/context/MemberContext';
import { useUIContext } from '@/context/UIContext';
import { useAuthContext } from '@/context/AuthContext';
import type { Task, Project, User as UserType } from '@/types';

// ── Types ────────────────────────────────────────────────────────────────────

interface TaskResult {
  kind: 'task';
  task: Task;
  projectName: string;
}

interface ProjectResult {
  kind: 'project';
  project: Project;
}

interface MemberResult {
  kind: 'member';
  user: UserType;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const MAX_TASKS = 8;
const MAX_PROJECTS = 5;
const MAX_MEMBERS = 5;
const DEBOUNCE_MS = 300;

function normalize(s: string): string {
  return s.toLowerCase();
}

function matchesQuery(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CommandPalette() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  const { allTasks, taskSpecs } = useTaskContext();
  const { allProjects, productLines, setSelectedProjectId, setSelectedLineId } = useProjectContext();
  const { users } = useMemberContext();
  const { currentView, setSelectedTask, setCurrentView, showCreateTask, setShowCreateTask } = useUIContext();

  // ── Keyboard shortcut ──────────────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        // Don't trigger if a modal/dialog is already open
        if (showCreateTask || open) return;
        e.preventDefault();
        setShowCreateTask(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showCreateTask, open, setShowCreateTask]);

  // ── Debounce ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // Reset query when dialog closes
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // ── Lookup maps ────────────────────────────────────────────────────────────

  const projectMap = useMemo<Map<string, Project>>(() => {
    const map = new Map<string, Project>();
    allProjects.forEach(p => map.set(p.id, p));
    return map;
  }, [allProjects]);

  const specByTaskId = useMemo<Map<string, string>>(() => {
    const map = new Map<string, string>();
    taskSpecs.forEach(spec => {
      const combined = [spec.background, spec.requirement, spec.notes]
        .filter(Boolean)
        .join(' ');
      map.set(spec.taskId, combined);
    });
    return map;
  }, [taskSpecs]);

  // ── Recent tasks (empty-state) ─────────────────────────────────────────────

  const recentTasks = useMemo<TaskResult[]>(() => {
    return [...allTasks]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, MAX_TASKS)
      .map(task => ({
        kind: 'task' as const,
        task,
        projectName: projectMap.get(task.projectId)?.name ?? '',
      }));
  }, [allTasks, projectMap]);

  // ── Search results ─────────────────────────────────────────────────────────

  const results = useMemo<{
    tasks: TaskResult[];
    projects: ProjectResult[];
    members: MemberResult[];
  }>(() => {
    const q = debouncedQuery.trim();
    if (!q) return { tasks: [], projects: [], members: [] };

    const tasks: TaskResult[] = allTasks
      .filter(task => {
        const spec = specByTaskId.get(task.id) ?? '';
        return (
          matchesQuery(task.title, q) ||
          matchesQuery(task.taskKey, q) ||
          matchesQuery(spec, q)
        );
      })
      .slice(0, MAX_TASKS)
      .map(task => ({
        kind: 'task' as const,
        task,
        projectName: projectMap.get(task.projectId)?.name ?? '',
      }));

    const projects: ProjectResult[] = allProjects
      .filter(p => matchesQuery(p.name, q) || matchesQuery(p.key, q))
      .slice(0, MAX_PROJECTS)
      .map(p => ({ kind: 'project' as const, project: p }));

    const members: MemberResult[] = users
      .filter(u => matchesQuery(u.name, q) || matchesQuery(u.email, q))
      .slice(0, MAX_MEMBERS)
      .map(u => ({ kind: 'member' as const, user: u }));

    return { tasks, projects, members };
  }, [debouncedQuery, allTasks, allProjects, users, projectMap, specByTaskId]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleSelectTask = useCallback((task: Task) => {
    setOpen(false);
    // Opens the way the member chose (modal, side panel or page).
    setSelectedTask(task);
  }, [setSelectedTask]);

  const handleSelectProject = useCallback((project: Project) => {
    setOpen(false);
    if (scopeChangeBlocked()) return;
    setSelectedProjectId(project.id);
    setSelectedLineId(null);
    // Same rule as the sidebar: a scoped view stays, anything else opens the board.
    setCurrentView(viewAfterScopeChange(currentView, 'scope'));
  }, [currentView, setSelectedProjectId, setSelectedLineId, setCurrentView]);

  const { permissions } = useAuthContext();
  // Member management is for admins; everyone else finds people on the team page.
  const handleSelectMember = useCallback((_user: UserType) => {
    setOpen(false);
    setCurrentView(permissions.canViewMemberList ? 'team-manage' : 'team-intro');
  }, [permissions.canViewMemberList, setCurrentView]);

  // ── Derived display state ──────────────────────────────────────────────────

  const isSearching = debouncedQuery.trim().length > 0;
  // The list is filtered here, not by cmdk, so cmdk keeps highlighting an item that
  // is gone and Enter does nothing. Highlight the first item whenever the list changes.
  const firstItem = isSearching
    ? results.tasks[0] ? `task-${results.tasks[0].task.id}` : results.projects[0] ? `project-${results.projects[0].project.id}` : results.members[0] ? `member-${results.members[0].user.id}` : ''
    : 'action-create-task';
  const [activeItem, setActiveItem] = useState(firstItem);
  useEffect(() => { setActiveItem(firstItem); }, [firstItem, open]);
  const hasResults =
    results.tasks.length > 0 ||
    results.projects.length > 0 ||
    results.members.length > 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  // Results are matched above on title, key, spec, name and email; the list must not filter them again by item id.
  return (
    <CommandDialog open={open} onOpenChange={setOpen} title={t('common.search')} shouldFilter={false} value={activeItem} onValueChange={setActiveItem}>
      <CommandInput
        placeholder={t('search.commandPlaceholder')}
        value={query}
        onValueChange={setQuery}
        aria-label={t('common.search')}
      />
      <CommandList className="max-h-[480px]">
        {isSearching && !hasResults && (
          <CommandEmpty>{t('search.noMatches', { query: debouncedQuery })}</CommandEmpty>
        )}

        {/* ── Search results ── */}
        {isSearching && results.tasks.length > 0 && (
          <CommandGroup heading={t('search.tasksGroup')}>
            {results.tasks.map(({ task, projectName }) => (
              <CommandItem
                key={task.id}
                value={`task-${task.id}`}
                onSelect={() => handleSelectTask(task)}
                className="flex items-center gap-2"
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{task.title}</span>
                {projectName && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {projectName}
                  </span>
                )}
                <span className="text-xs text-muted-foreground shrink-0 font-mono">
                  {task.taskKey}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {isSearching && results.tasks.length > 0 && results.projects.length > 0 && (
          <CommandSeparator />
        )}

        {isSearching && results.projects.length > 0 && (
          <CommandGroup heading={t('search.projectsGroup')}>
            <ProjectGroupedList groups={groupProjectsByLine(productLines, results.projects.map(result => result.project), { archived: 'all' })}>{project => (
              <CommandItem
                key={project.id}
                value={`project-${project.id}`}
                onSelect={() => handleSelectProject(project)}
                className="flex items-center gap-2"
              >
                <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{project.name}</span>
                <span className="text-xs text-muted-foreground shrink-0 font-mono">
                  {project.key}
                </span>
              </CommandItem>
            )}</ProjectGroupedList>
          </CommandGroup>
        )}

        {isSearching &&
          results.projects.length > 0 &&
          results.members.length > 0 && <CommandSeparator />}

        {isSearching && results.members.length > 0 && (
          <CommandGroup heading={t('search.membersGroup')}>
            {results.members.map(({ user }) => (
              <CommandItem
                key={user.id}
                value={`member-${user.id}`}
                onSelect={() => handleSelectMember(user)}
                className="flex items-center gap-2"
              >
                <User className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{user.name}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {user.jobTitle}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* ── Quick actions ── */}
        {!isSearching && (
          <CommandGroup heading={t('search.actionsGroup')}>
            <CommandItem
              value="action-create-task"
              onSelect={() => { setOpen(false); setShowCreateTask(true); }}
              className="flex items-center gap-2"
            >
              <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">{t('search.createTaskAction')}</span>
              <kbd className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">⌘N</kbd>
            </CommandItem>
          </CommandGroup>
        )}

        {!isSearching && recentTasks.length > 0 && <CommandSeparator />}

        {/* ── Empty state: recent tasks ── */}
        {!isSearching && recentTasks.length > 0 && (
          <CommandGroup heading={t('search.recentTasks')}>
            {recentTasks.map(({ task, projectName }) => (
              <CommandItem
                key={task.id}
                value={`recent-${task.id}`}
                onSelect={() => handleSelectTask(task)}
                className="flex items-center gap-2"
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{task.title}</span>
                {projectName && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {projectName}
                  </span>
                )}
                <span className="text-xs text-muted-foreground shrink-0 font-mono">
                  {task.taskKey}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
