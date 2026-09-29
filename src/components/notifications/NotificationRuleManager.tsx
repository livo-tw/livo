import { useState, useEffect } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useNotificationRules } from '@/hooks/useNotificationRules';
import { useNotificationTemplates } from '@/hooks/useNotificationTemplates';
import { useAppContext } from '@/context/AppContext';
import { AddRuleDialog, type NewRuleForm } from './AddRuleDialog';

const EVENT_LABELS: Record<string, string> = {
  task_created: '任務建立',
  status_changed: '狀態變更',
  assignee_changed: '指派變更',
  due_reminder: '截止提醒',
  overdue: '已逾期',
  approval_requested: '請求審核',
  approval_completed: '審核完成',
  comment_added: '新增留言',
  custom: '自訂',
};

const NotificationRuleManager = () => {
  const { rules, loading, fetchRules, createRule, deleteRule, toggleRule } = useNotificationRules();
  const { templates, fetchTemplates } = useNotificationTemplates();
  const { statuses } = useAppContext();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  useEffect(() => {
    void fetchRules();
    void fetchTemplates();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const statusNames = statuses.map(s => s.name);

  const handleCreate = async (form: NewRuleForm) => {
    const channels = form.channel_target
      ? [{ type: form.channel_type, target: form.channel_target }]
      : [];
    await createRule({
      project_id: null,
      event_type: form.event_type,
      from_status: form.from_status || null,
      to_status: form.to_status || null,
      is_enabled: true,
      template_id: form.template_id || null,
      target_channels: channels,
      priority_overrides: {},
      auto_send: form.auto_send,
      auto_send_delay_seconds: form.auto_send_delay_seconds,
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <Button size="sm" className="gap-1.5" onClick={() => setDialogOpen(true)}>
          <Plus size={14} />
          新增規則
        </Button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">載入中…</div>
      ) : rules.length === 0 ? (
        <div className="text-sm text-muted-foreground py-10 text-center border border-dashed border-border rounded-lg bg-muted/10">
          尚無通知規則，點擊「新增規則」建立第一條規則。
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">事件類型</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">狀態條件</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">範本</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">頻道</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">自動</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">啟用</th>
                <th className="px-4 py-2.5 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rules.map(rule => {
                const tmpl = templates.find(t => t.id === rule.template_id);
                return (
                  <tr key={rule.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className="text-xs font-normal">
                        {EVENT_LABELS[rule.event_type] ?? rule.event_type}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {rule.from_status || rule.to_status ? (
                        <span>
                          {rule.from_status || '任意'} → {rule.to_status || '任意'}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/60">任意狀態</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {tmpl ? (
                        <span className="truncate max-w-[140px] block">{tmpl.name}</span>
                      ) : (
                        <span className="text-muted-foreground/60">預設</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(rule.target_channels ?? []).map((ch, i) => (
                          <Badge key={i} variant="outline" className="text-xs font-normal">
                            {ch.type}: {ch.target}
                          </Badge>
                        ))}
                        {(rule.target_channels ?? []).length === 0 && (
                          <span className="text-xs text-muted-foreground/60">無</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {rule.auto_send ? `${rule.auto_send_delay_seconds}s` : '手動'}
                    </td>
                    <td className="px-4 py-3">
                      <Switch
                        checked={rule.is_enabled}
                        onCheckedChange={v => void toggleRule(rule.id, v)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        aria-label="刪除規則"
                        onClick={() => setDeleteConfirmId(rule.id)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 優先順序策略說明 */}
      <div className="bg-muted/30 border border-border rounded-lg p-4 text-sm text-muted-foreground space-y-1">
        <p className="font-semibold text-foreground text-sm">訊息優先順序策略</p>
        <p className="text-xs leading-relaxed">專案層級規則優先於全域規則。同一事件有多條規則時，取最高優先順序（最先匹配的專案規則）。</p>
      </div>

      <AddRuleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        templates={templates}
        statusNames={statusNames}
        onSubmit={handleCreate}
      />

      {/* Delete confirm dialog */}
      <Dialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>刪除規則</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            確定要刪除此通知規則嗎？此操作無法復原。
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirmId(null)}>取消</Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => { if (deleteConfirmId) { void deleteRule(deleteConfirmId); setDeleteConfirmId(null); } }}
            >
              刪除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default NotificationRuleManager;
