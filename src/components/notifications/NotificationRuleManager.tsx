import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useNotificationRules } from '@/hooks/useNotificationRules';
import { useNotificationTemplates } from '@/hooks/useNotificationTemplates';
import { useAppContext } from '@/context/AppContext';
import { AddRuleDialog, type NewRuleForm } from './AddRuleDialog';
import { eventLabel, ruleEventFires } from './notificationLabels';

const NotificationRuleManager = () => {
  const { t } = useTranslation();
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
          {t('notificationRules.addRule')}
        </Button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">{t('common.loading')}</div>
      ) : rules.length === 0 ? (
        <div className="text-sm text-muted-foreground py-10 text-center border border-dashed border-border rounded-lg bg-muted/10">
          {t('notificationRules.empty')}
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">{t('notificationRules.eventType')}</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">{t('notificationRules.table.statusCondition')}</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">{t('notificationRules.table.template')}</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">{t('notificationRules.table.channel')}</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">{t('notificationRules.table.auto')}</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">{t('notificationRules.table.enabled')}</th>
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
                        {eventLabel(t, rule.event_type)}
                      </Badge>
                      {!ruleEventFires(rule.event_type) && (
                        <p className="text-[10px] text-muted-foreground mt-1" title={t('notificationRules.neverFiresHint')}>
                          {t('notificationRules.neverFires')}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {rule.from_status || rule.to_status ? (
                        <span>
                          {rule.from_status || t('notificationRules.any')} → {rule.to_status || t('notificationRules.any')}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/60">{t('notificationRules.anyStatus')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {tmpl ? (
                        <span className="truncate max-w-[140px] block">{tmpl.name}</span>
                      ) : (
                        <span className="text-muted-foreground/60">{t('notificationRules.default')}</span>
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
                          <span className="text-xs text-muted-foreground/60">{t('common.none')}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {rule.auto_send ? `${rule.auto_send_delay_seconds}s` : t('notificationRules.manual')}
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
                        aria-label={t('notificationRules.deleteRule')}
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
        <p className="font-semibold text-foreground text-sm">{t('notificationRules.priorityPolicyTitle')}</p>
        <p className="text-xs leading-relaxed">{t('notificationRules.priorityPolicyDescription')}</p>
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
            <DialogTitle>{t('notificationRules.deleteRule')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            {t('notificationRules.deleteRuleConfirm')}
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirmId(null)}>{t('common.cancel')}</Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => { if (deleteConfirmId) { void deleteRule(deleteConfirmId); setDeleteConfirmId(null); } }}
            >
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default NotificationRuleManager;
