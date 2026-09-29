import { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import { requestQueries, actionQueries, type ApprovalRequest, type ApprovalAction } from '@/lib/approvalQueries';

/* ── Approval History ── */
export function ApprovalHistory({ taskId, requiresApproval, users, statuses }: { taskId: string; requiresApproval?: boolean; users: { id: string; name: string; avatar: string; color: string }[]; statuses: { id: string; name: string; color: string }[] }) {
  const { t } = useTranslation();
  const [detailOpen, setDetailOpen] = useState(false);
  const [requests, setRequests] = useState<(ApprovalRequest & { actions: ApprovalAction[] })[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: reqs } = await requestQueries.fetchByTask(supabase, taskId);
      if (cancelled) return;
      if (!reqs || reqs.length === 0) { setRequests([]); setLoaded(true); return; }
      const withActions = await Promise.all(
        (reqs as ApprovalRequest[]).map(async (r) => {
          const { data: acts } = await actionQueries.fetchByRequest(supabase, r.id);
          return { ...r, actions: (acts as ApprovalAction[]) || [] };
        })
      );
      if (!cancelled) { setRequests(withActions); setLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  const userName = (id: string) => users.find(u => u.id === id)?.name || id;
  const statusName = (id: string) => statuses.find(s => s.id === id)?.name || id;
  const actionIcon = (action: string) => {
    if (action === 'approve') return <CheckCircle2 size={12} className="text-emerald-500" />;
    if (action === 'reject') return <XCircle size={12} className="text-red-500" />;
    return <RotateCcw size={12} className="text-amber-500" />;
  };
  const statusLabel = (s: ApprovalRequest['status']) => {
    const map: Record<string, string> = {
      pending: t('taskDetail.sidebar.approvalPending'),
      approved: t('taskDetail.sidebar.approvalApproved'),
      rejected: t('taskDetail.sidebar.approvalRejected'),
      returned: t('taskDetail.sidebar.approvalReturned'),
      cancelled: t('taskDetail.sidebar.approvalCancelled'),
    };
    return map[s] || s;
  };
  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // Don't render if task doesn't require approval AND has no history
  if (loaded && requests.length === 0 && !requiresApproval) return null;

  const latestCompleted = requests.find(r => r.status !== 'pending');
  const latestApprover = latestCompleted?.actions?.length
    ? latestCompleted.actions[latestCompleted.actions.length - 1]
    : null;

  const badgeColor = latestCompleted?.status === 'approved'
    ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
    : latestCompleted?.status === 'rejected'
    ? 'bg-red-500/15 text-red-700 border-red-500/30'
    : latestCompleted?.status === 'returned'
    ? 'bg-amber-500/15 text-amber-700 border-amber-500/30'
    : 'bg-purple-500/15 text-purple-700 border-purple-500/30';

  return (
    <div className="mt-2 space-y-1.5">
      {latestCompleted && (
        <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border ${badgeColor}`}>
          {latestCompleted.status === 'approved' ? <CheckCircle2 size={14} /> : latestCompleted.status === 'rejected' ? <XCircle size={14} /> : <RotateCcw size={14} />}
          <div className="flex-1 min-w-0">
            <span className="text-xs font-semibold">{statusLabel(latestCompleted.status)}</span>
            {latestApprover && (
              <span className="text-[10px] ml-1.5 opacity-80">
                {userName(latestApprover.action_by)} · {fmtTime(latestApprover.acted_at)}
              </span>
            )}
          </div>
        </div>
      )}

      {requests.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setDetailOpen(v => !v)}
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {detailOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {t('taskDetail.sidebar.approvalHistory')} ({requests.length})
          </button>
          {detailOpen && (
            <div className="space-y-2">
              {requests.map(req => (
                <div key={req.id} className="border border-border/60 rounded-lg p-2 bg-muted/30">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">
                      {statusName(req.from_status)} → {statusName(req.to_status)}
                    </span>
                    <span className={`font-medium ${req.status === 'approved' ? 'text-emerald-600' : req.status === 'rejected' ? 'text-red-600' : req.status === 'returned' ? 'text-amber-600' : 'text-purple-600'}`}>
                      {statusLabel(req.status)}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {t('taskDetail.sidebar.approvalRequestedBy', { name: userName(req.requested_by) })} · {fmtTime(req.created_at)}
                  </div>
                  {req.actions.length > 0 && (
                    <div className="mt-1.5 space-y-1 pl-2 border-l-2 border-border/50">
                      {req.actions.map(act => (
                        <div key={act.id} className="flex items-center gap-1.5 text-[10px]">
                          {actionIcon(act.action)}
                          <span className="font-medium text-foreground">{userName(act.action_by)}</span>
                          <span className="text-muted-foreground">{fmtTime(act.acted_at)}</span>
                          {act.comment && <span className="text-muted-foreground truncate max-w-[120px]" title={act.comment}>— {act.comment}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default ApprovalHistory;
