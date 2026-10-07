import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { moveSidebarItem, normalizeSidebarOrder, sortSidebarItems, type SidebarOrder } from '@/lib/sidebarOrder';
import type { ProductLineOption, ProjectOption } from '@/lib/projectGroups';

interface SidebarOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: readonly ProductLineOption[];
  projects: readonly ProjectOption[];
  lineOrder: string[];
  projectOrder: string[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  onSave: (value: { lineOrder: string[]; projectOrder: string[] }) => Promise<boolean>;
}

/** Keep preferences for items the caller currently cannot see in their own slots. */
function replaceVisibleOrder(current: readonly string[], visible: readonly string[]): string[] {
  const visibleIds = new Set(visible);
  const complete = [...current, ...visible.filter(id => !current.includes(id))];
  let cursor = 0;
  return complete.map(id => visibleIds.has(id) ? visible[cursor++] : id);
}

const SidebarOrderDialog = ({ open, onOpenChange, lines, projects, lineOrder, projectOrder, loading, saving, error, onSave }: SidebarOrderDialogProps) => {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState<SidebarOrder>(() => normalizeSidebarOrder({ version: 1, lineOrder, projectOrder }));
  const [saveFailed, setSaveFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const wasOpen = useRef(false);
  const submissionRef = useRef(false);
  const locale = i18n?.language;

  useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(normalizeSidebarOrder({ version: 1, lineOrder, projectOrder }));
      setSaveFailed(false);
      setAnnouncement('');
    }
    wasOpen.current = open;
  }, [open, lineOrder, projectOrder]);

  // A failed initial read must never become a write of an unknown preference.
  // A failed save keeps the draft available for an explicit retry.
  const readUnavailable = loading || error === 'load';
  const isSaving = saving || submitting;
  const controlsDisabled = readUnavailable || isSaving;
  const saved = normalizeSidebarOrder({ version: 1, lineOrder, projectOrder });
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const orderedLines = useMemo(() => sortSidebarItems(lines, draft.lineOrder, locale), [lines, draft.lineOrder, locale]);
  const groups = useMemo(() => orderedLines.map(line => ({
    line,
    projects: sortSidebarItems(projects.filter(project => project.lineId === line.id && !project.isArchived), draft.projectOrder, locale),
  })), [orderedLines, projects, draft.projectOrder, locale]);

  const moveLine = (index: number, direction: number) => {
    const ids = moveSidebarItem(orderedLines.map(line => line.id), index, index + direction);
    setDraft(previous => ({ ...previous, lineOrder: replaceVisibleOrder(previous.lineOrder, ids) }));
    setAnnouncement(t('sidebar.orderMoved', { name: orderedLines[index].name, position: index + direction + 1 }));
  };
  const moveProject = (ids: string[], index: number, direction: number, name: string) => {
    const next = moveSidebarItem(ids, index, index + direction);
    setDraft(previous => ({ ...previous, projectOrder: replaceVisibleOrder(previous.projectOrder, next) }));
    setAnnouncement(t('sidebar.orderMoved', { name, position: index + direction + 1 }));
  };
  const requestOpenChange = (next: boolean) => {
    if (!isSaving && !submissionRef.current) onOpenChange(next);
  };
  const save = async () => {
    if (controlsDisabled || !dirty || submissionRef.current) return;
    submissionRef.current = true;
    setSubmitting(true);
    try {
      const next = normalizeSidebarOrder(draft);
      if (await onSave({ lineOrder: next.lineOrder, projectOrder: next.projectOrder })) {
        onOpenChange(false);
      } else {
        setSaveFailed(true);
      }
    } catch {
      setSaveFailed(true);
    } finally {
      submissionRef.current = false;
      setSubmitting(false);
    }
  };
  const moveButtons = (name: string, index: number, length: number, move: (direction: number) => void) => <div className="flex shrink-0 gap-1">
    <Button type="button" variant="outline" size="icon" className="h-11 w-11" disabled={controlsDisabled || index === 0}
      aria-label={t('sidebar.orderMoveUp', { name })} title={t('sidebar.orderMoveUp', { name })} onClick={() => move(-1)}>
      <ArrowUp aria-hidden="true" />
    </Button>
    <Button type="button" variant="outline" size="icon" className="h-11 w-11" disabled={controlsDisabled || index === length - 1}
      aria-label={t('sidebar.orderMoveDown', { name })} title={t('sidebar.orderMoveDown', { name })} onClick={() => move(1)}>
      <ArrowDown aria-hidden="true" />
    </Button>
  </div>;

  return <Dialog open={open} onOpenChange={requestOpenChange}>
    <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-xl"
      onEscapeKeyDown={event => { if (isSaving || submissionRef.current) event.preventDefault(); }}
      onInteractOutside={event => { if (isSaving || submissionRef.current) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>{t('sidebar.orderTitle')}</DialogTitle>
        <DialogDescription>{t('sidebar.orderDescription')}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pr-1">
        {loading && <p role="status" className="text-sm text-muted-foreground">{t('sidebar.orderLoading')}</p>}
        {error === 'load' && <p role="alert" className="text-sm text-destructive">{t('sidebar.orderLoadFailed')}</p>}
        {(saveFailed || error === 'save') && <p role="alert" className="text-sm text-destructive">{t('sidebar.orderSaveFailed')}</p>}
        <section aria-label={t('sidebar.orderLines')}>
          <h3 className="mb-2 text-sm font-semibold">{t('sidebar.orderLines')}</h3>
          {orderedLines.length === 0 ? <p className="text-sm text-muted-foreground">{t('sidebar.orderEmptyLines')}</p> : <ol className="space-y-2">
            {orderedLines.map((line, index) => <li key={line.id} className="flex min-w-0 items-center justify-between gap-3 rounded-md border p-2">
              <span className="min-w-0 break-words text-sm">{line.icon && <span className="mr-1.5" aria-hidden="true">{line.icon}</span>}{line.name}</span>
              {moveButtons(line.name, index, orderedLines.length, direction => moveLine(index, direction))}
            </li>)}
          </ol>}
        </section>
        <section aria-label={t('sidebar.orderProjects')} className="space-y-4">
          <h3 className="text-sm font-semibold">{t('sidebar.orderProjects')}</h3>
          {groups.map(({ line, projects: rows }) => <section key={line.id} aria-label={t('sidebar.orderProjectsInLine', { name: line.name })}>
            <h4 className="mb-2 break-words text-sm font-medium text-muted-foreground">{line.name}</h4>
            {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('sidebar.orderEmptyProjects')}</p> : <ol className="space-y-2">
              {rows.map((project, index) => <li key={project.id} className="flex min-w-0 items-center justify-between gap-3 rounded-md border p-2">
                <span className="min-w-0 break-words text-sm">{project.name}</span>
                {moveButtons(project.name, index, rows.length, direction => moveProject(rows.map(row => row.id), index, direction, project.name))}
              </li>)}
            </ol>}
          </section>)}
        </section>
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      <DialogFooter className="flex-wrap sm:justify-between">
        <Button type="button" variant="outline" className="min-h-11" disabled={controlsDisabled || !(draft.lineOrder.length || draft.projectOrder.length)} onClick={() => {
          setDraft(normalizeSidebarOrder({ version: 1, lineOrder: [], projectOrder: [] }));
          setAnnouncement(t('sidebar.orderResetDone'));
        }}><RotateCcw aria-hidden="true" />{t('sidebar.orderReset')}</Button>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" className="min-h-11" disabled={isSaving} onClick={() => requestOpenChange(false)}>{t('common.cancel')}</Button>
          <Button type="button" className="min-h-11" disabled={controlsDisabled || !dirty} onClick={save}>{t(isSaving ? 'sidebar.orderSaving' : 'common.save')}</Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
};

export default SidebarOrderDialog;
