import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, Download, FileText, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { fnUrl } from '@/lib/apiBase';
import { logActivity } from '@/lib/activityLog';
import { toast } from 'sonner';
import UpgradePrompt from '@/components/UpgradePrompt';
import type { FeatureName } from '@/lib/license';

interface ImportResult {
  success?: boolean;
  // dryRun === true means the worker parsed the CSV but wrote NOTHING (non-professional caller).
  dryRun?: boolean;
  stats?: {
    // real-import counts (professional)
    tasksInserted?: number;
    commentsInserted?: number;
    specsInserted?: number;
    sprintsCreated?: number;
    // dry-run parsed counts (standard preview)
    totalRows?: number;
    tasksParsed?: number;
    commentsParsed?: number;
    specsParsed?: number;
    sprintsParsed?: number;
    newMembers?: string[];
  };
}

interface AdminImportExportSectionProps {
  currentMemberId: string;
  hasFeature: (feature: FeatureName) => boolean;
  refreshAll: () => Promise<unknown>;
}

function escCsv(val: string): string {
  if (!val) return '';
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function groupBy<T extends Record<string, unknown>>(arr: T[], key: string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const k = item[key] as string;
    if (!result[k]) result[k] = [];
    result[k].push(item);
  }
  return result;
}

const AdminImportExportSection = ({ currentMemberId, hasFeature, refreshAll }: AdminImportExportSectionProps) => {
  const { t } = useTranslation();
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [exporting, setExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setImporting(true);
      setImportStatus(t('adminImportExport.readingCsv'));
      setImportResult(null);
      const csvText = await file.text();
      setImportStatus(`CSV 已讀取 (${(csvText.length / 1024).toFixed(1)} KB)，正在匯入...`);
      const url = fnUrl('import-jira');
      const { data: { session } } = await supabase.auth.getSession();
      const fnResp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'Authorization': `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}` },
        body: csvText,
      });
      const data = await fnResp.json() as ImportResult;
      if (!fnResp.ok) {
        setImportStatus(t('adminImportExport.importFailed'));
        toast.error(t('adminImportExport.importFailed') + ': ' + JSON.stringify(data));
      } else if (data.dryRun) {
        // Standard-tier SAFE PREVIEW: nothing was written to the DB.
        setImportStatus(t('adminImportExport.previewComplete'));
        setImportResult(data);
        // No success toast — this is a format preview, not an import.
      } else {
        setImportStatus(t('adminImportExport.importComplete'));
        setImportResult(data);
        toast.success(`成功匯入 ${data.stats?.tasksInserted || 0} 個任務`);
        if (currentMemberId) {
          await logActivity(currentMemberId, 'import_jira', `匯入 Jira CSV，共 ${data.stats?.tasksInserted || 0} 個任務`, undefined, undefined, 'system');
        }
        await refreshAll();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setImportStatus(t('adminImportExport.importError') + ' ' + msg);
      toast.error(t('adminImportExport.importError') + ' ' + msg);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleExport = async () => {
    try {
      setExporting(true);
      const [tasksRes, membersRes, projectsRes, statusesRes, sprintsRes, commentsRes, specsRes, checksRes, todosRes, deploysRes, statusLogsRes] = await Promise.all([
        supabase.from('tasks').select('*').order('created_at', { ascending: true }),
        supabase.from('members').select('*'),
        supabase.from('projects').select('*'),
        supabase.from('statuses').select('*'),
        supabase.from('sprints').select('*'),
        supabase.from('comments').select('*').order('created_at', { ascending: true }),
        supabase.from('task_specs').select('*'),
        supabase.from('task_checks').select('*').order('sort_order', { ascending: true }),
        supabase.from('task_todos').select('*').order('sort_order', { ascending: true }),
        supabase.from('task_deployments').select('*'),
        supabase.from('status_logs').select('*').order('changed_at', { ascending: true }),
      ]);

      const tasks = tasksRes.data || [];
      const members = membersRes.data || [];
      const projects = projectsRes.data || [];
      const statuses = statusesRes.data || [];
      const sprints = sprintsRes.data || [];
      const comments = commentsRes.data || [];
      const specs = specsRes.data || [];
      const checks = checksRes.data || [];
      const todos = todosRes.data || [];
      const deploys = deploysRes.data || [];
      const statusLogs = statusLogsRes.data || [];

      const memberMap = Object.fromEntries(members.map(m => [m.id, m.name]));
      const projectMap = Object.fromEntries(projects.map(p => [p.id, p.name]));
      const statusMap = Object.fromEntries(statuses.map(s => [s.id, s.name]));
      const sprintMap = Object.fromEntries(sprints.map(s => [s.id, s.name]));

      const commentsByTask = groupBy(comments, 'task_id');
      const specsByTask = groupBy(specs, 'task_id');
      const checksByTask = groupBy(checks, 'task_id');
      const todosByTask = groupBy(todos, 'task_id');
      const deploysByTask = groupBy(deploys, 'task_id');
      const logsByTask = groupBy(statusLogs, 'task_id');

      const headers = [
        t('adminImportExport.csvHeaders.taskKey'), t('adminImportExport.csvHeaders.title'), t('adminImportExport.csvHeaders.project'), t('adminImportExport.csvHeaders.status'), t('adminImportExport.csvHeaders.priority'),
        t('adminImportExport.csvHeaders.assignee'), t('adminImportExport.csvHeaders.reviewer'), t('adminImportExport.csvHeaders.creator'), t('adminImportExport.csvHeaders.department'),
        t('adminImportExport.csvHeaders.createdAt'), t('adminImportExport.csvHeaders.startedAt'), t('adminImportExport.csvHeaders.dueDate'), t('adminImportExport.csvHeaders.completedAt'),
        t('adminImportExport.csvHeaders.sprint'), 'GitLab URL', t('adminImportExport.csvHeaders.sortOrder'),
        t('adminImportExport.csvHeaders.specBackground'), t('adminImportExport.csvHeaders.specRequirement'), t('adminImportExport.csvHeaders.specNotes'),
        t('adminImportExport.csvHeaders.checks'), t('adminImportExport.csvHeaders.todos'),
        t('adminImportExport.csvHeaders.deployments'), t('adminImportExport.csvHeaders.statusLogs'), t('adminImportExport.csvHeaders.comments'),
      ];

      const csvRows = [headers.join(',')];

      for (const t of tasks) {
        const taskComments = commentsByTask[t.id] || [];
        const taskSpecs = specsByTask[t.id] || [];
        const taskChecks = checksByTask[t.id] || [];
        const taskTodos = todosByTask[t.id] || [];
        const taskDeploys = deploysByTask[t.id] || [];
        const taskLogs = logsByTask[t.id] || [];

        const spec = taskSpecs[0];
        const checksStr = taskChecks.map(c => `${c.is_done ? '[✓]' : '[ ]'} ${c.text}`).join('\n');
        const todosStr = taskTodos.map(c => `${c.is_done ? '[✓]' : '[ ]'} ${c.text}`).join('\n');
        const deploysStr = taskDeploys.map(d => `${d.environment}: ${d.status}${d.deploy_date ? ' (' + d.deploy_date + ')' : ''}`).join('\n');
        const logsStr = taskLogs.map(l => {
          const from = l.from_status_id ? statusMap[l.from_status_id as string] || l.from_status_id : '(無)';
          const to = statusMap[l.to_status_id as string] || l.to_status_id;
          const by = memberMap[l.changed_by as string] || l.changed_by;
          return `${from} → ${to} (${by}, ${l.changed_at})`;
        }).join('\n');
        const commentsStr = taskComments.map(c => {
          const user = memberMap[c.user_id as string] || c.user_id;
          return `[${user} @ ${c.created_at}] ${stripHtml(c.content as string)}`;
        }).join('\n');

        csvRows.push([
          escCsv(t.task_key), escCsv(t.title),
          escCsv(projectMap[t.project_id] || t.project_id),
          escCsv(statusMap[t.status_id] || t.status_id),
          escCsv(t.priority),
          escCsv(memberMap[t.assignee_id || ''] || ''),
          escCsv(memberMap[t.reviewer_id || ''] || ''),
          escCsv(memberMap[t.creator_id] || ''),
          escCsv(t.department || ''),
          escCsv(t.created_at || ''), escCsv(t.started_at || ''),
          escCsv(t.due_date || ''), escCsv(t.completed_at || ''),
          escCsv(sprintMap[t.sprint_id || ''] || ''),
          escCsv(t.gitlab_url || ''), escCsv(String(t.sort_order)),
          escCsv((spec as Record<string, unknown>)?.background as string || ''),
          escCsv(stripHtml((spec as Record<string, unknown>)?.requirement as string || '')),
          escCsv(stripHtml((spec as Record<string, unknown>)?.notes as string || '')),
          escCsv(checksStr), escCsv(todosStr),
          escCsv(deploysStr), escCsv(logsStr), escCsv(commentsStr),
        ].join(','));
      }

      const csvContent = '\uFEFF' + csvRows.join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const now = new Date();
      a.href = url;
      a.download = `export_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t('adminImportExport.exportSuccess', { count: tasks.length }));
      if (currentMemberId) {
        await logActivity(currentMemberId, 'export_csv', t('activityLog.exportCsv', { count: tasks.length }), undefined, undefined, 'system');
      }
    } catch (err: unknown) {
      toast.error(t('adminImportExport.exportError') + ' ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-foreground flex items-center gap-2 border-b border-border pb-2">
        <Download size={18} className="text-primary" />
        {t('adminImportExport.sectionTitle')}
      </h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Importer is always visible. Professional callers get the real (destructive) import;
            non-professional callers get a SAFE DRY-RUN preview (worker writes nothing). */}
        {(() => {
          const isPro = hasFeature('jira-import');
          const dryRunResult = importResult?.dryRun ? importResult : null;
          return (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Download size={20} className="text-primary" />
              {t('adminImportExport.importTitle')}
            </CardTitle>
            <CardDescription>{isPro ? t('adminImportExport.importDesc') : t('adminImportExport.previewDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!isPro && (
              <p className="text-xs text-muted-foreground">{t('adminImportExport.previewNote')}</p>
            )}
            <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileSelect} className="hidden" />
            <Button onClick={handleImportClick} disabled={importing} variant="default" className="gap-2">
              <Download size={16} />
              {importing
                ? t('adminImportExport.importing')
                : (isPro ? t('adminImportExport.selectCsvButton') : t('adminImportExport.previewCsvButton'))}
            </Button>
            {importStatus && (
              <div className="p-3 rounded-md bg-muted text-sm text-muted-foreground">
                <p className="flex items-center gap-2"><FileText size={14} />{importStatus}</p>
              </div>
            )}
            {importResult && dryRunResult ? (
              <div className="p-3 rounded-md bg-muted text-sm space-y-3">
                <div>
                  <p className="font-medium text-foreground mb-1">{t('adminImportExport.previewResultTitle')}</p>
                  <ul className="space-y-0.5 text-muted-foreground">
                    <li>• {t('adminImportExport.previewTotalRows')}{dryRunResult.stats?.totalRows || 0} 筆</li>
                    <li>• {t('adminImportExport.resultTasks')}{dryRunResult.stats?.tasksParsed || 0} 筆</li>
                    <li>• {t('adminImportExport.resultComments')}{dryRunResult.stats?.commentsParsed || 0} 筆</li>
                    <li>• {t('adminImportExport.resultSpecs')}{dryRunResult.stats?.specsParsed || 0} 筆</li>
                    <li>• {t('adminImportExport.resultSprints')}{dryRunResult.stats?.sprintsParsed || 0} 個</li>
                    {(dryRunResult.stats?.newMembers?.length ?? 0) > 0 && <li>• {t('adminImportExport.resultNewMembers')}{dryRunResult.stats!.newMembers!.join(', ')}</li>}
                  </ul>
                </div>
                <UpgradePrompt feature="jira-import" inline />
              </div>
            ) : importResult ? (
              <div className="p-3 rounded-md bg-muted text-sm">
                <p className="font-medium text-foreground mb-1">{t('adminImportExport.resultTitle')}</p>
                <ul className="space-y-0.5 text-muted-foreground">
                  <li>• {t('adminImportExport.resultTasks')}{importResult.stats?.tasksInserted || 0} 筆</li>
                  <li>• {t('adminImportExport.resultComments')}{importResult.stats?.commentsInserted || 0} 筆</li>
                  <li>• {t('adminImportExport.resultSpecs')}{importResult.stats?.specsInserted || 0} 筆</li>
                  <li>• {t('adminImportExport.resultSprints')}{importResult.stats?.sprintsCreated || 0} 個</li>
                  {(importResult.stats?.newMembers?.length ?? 0) > 0 && <li>• {t('adminImportExport.resultNewMembers')}{importResult.stats!.newMembers!.join(', ')}</li>}
                </ul>
              </div>
            ) : null}
            {isPro && (
              <p className="text-xs text-destructive flex items-center gap-1.5">
                <AlertTriangle size={12} className="flex-shrink-0" />
                {t('adminImportExport.importWarning')}
              </p>
            )}
          </CardContent>
        </Card>
          );
        })()}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Upload size={20} className="text-primary" />
              {t('adminImportExport.exportTitle')}
            </CardTitle>
            <CardDescription>{t('adminImportExport.exportDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={handleExport} disabled={exporting} variant="outline" className="gap-2">
              <Upload size={16} />
              {exporting ? t('adminImportExport.exporting') : t('adminImportExport.exportButton')}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default AdminImportExportSection;
