import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { NotificationRule, NotificationTemplate, EventType } from '@/lib/notificationQueries';
import { RULE_EVENT_TYPES, eventLabel, ruleEventFires } from './notificationLabels';

// ── Add-rule dialog ───────────────────────────────────────────

interface AddRuleDialogProps {
  open: boolean;
  templates: NotificationTemplate[];
  onClose: () => void;
  onCreate: (rule: Omit<NotificationRule, 'id' | 'created_at' | 'updated_at'>) => void;
}

function AddRuleDialog({ open, templates, onClose, onCreate }: AddRuleDialogProps) {
  const { t } = useTranslation();
  const [eventType, setEventType] = useState<EventType>('status_changed');
  const [templateId, setTemplateId] = useState('');
  const [autoSend, setAutoSend] = useState(true);
  const [delay, setDelay] = useState(3);

  const handleCreate = () => {
    onCreate({
      project_id: null,
      event_type: eventType,
      from_status: null,
      to_status: null,
      is_enabled: true,
      template_id: templateId || null,
      target_channels: [{ type: 'slack', target: 'default' }],
      priority_overrides: {},
      auto_send: autoSend,
      auto_send_delay_seconds: delay,
    });
    onClose();
  };

  const filteredTemplates = templates.filter(t => t.event_type === eventType);

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('notificationRules.dialog.addTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('notificationRules.dialog.triggerEvent')}</label>
            <Select value={eventType} onValueChange={v => { setEventType(v as EventType); setTemplateId(''); }}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_EVENT_TYPES.map(e => (
                  <SelectItem key={e} value={e}>{eventLabel(t, e)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('notificationRules.dialog.useTemplate')}</label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder={t('notificationRules.dialog.selectTemplateOptional')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{t('notificationRules.dialog.templateNone')}</SelectItem>
                {filteredTemplates.map(t => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">{t('notificationRules.autoSend')}</span>
            <Switch checked={autoSend} onCheckedChange={setAutoSend} />
          </div>
          {autoSend && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {t('notificationRules.dialog.autoSendDelay')}
              </label>
              <input
                type="number"
                min={1}
                max={30}
                value={delay}
                onChange={e => setDelay(Number(e.target.value))}
                className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="sm" onClick={handleCreate}>{t('common.create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Rule row ──────────────────────────────────────────────────

interface RuleRowProps {
  rule: NotificationRule;
  templates: NotificationTemplate[];
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}

function RuleRow({ rule, templates, onToggle, onDelete }: RuleRowProps) {
  const { t } = useTranslation();
  const tpl = templates.find(t => t.id === rule.template_id);
  const channels = (rule.target_channels ?? []) as Array<{ type: string; target: string }>;

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
      <Switch
        checked={rule.is_enabled}
        onCheckedChange={v => onToggle(rule.id, v)}
        className="shrink-0"
      />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {eventLabel(t, rule.event_type)}
          </span>
          {!ruleEventFires(rule.event_type) && (
            <span className="text-[10px] text-muted-foreground" title={t('notificationRules.neverFiresHint')}>
              {t('notificationRules.neverFires')}
            </span>
          )}
          {rule.auto_send && (
            <span className="text-[10px] bg-muted text-muted-foreground rounded px-1.5 py-0.5">
              {t('notificationRules.autoDelay', { seconds: rule.auto_send_delay_seconds })}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {tpl ? tpl.name : t('notificationRules.noTemplate')}
          {channels.length > 0 && (
            <span className="ml-2 opacity-60">
              → {channels.map(c => `${c.type}:${c.target}`).join(', ')}
            </span>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
        onClick={() => onDelete(rule.id)}
        aria-label={t('notificationRules.deleteRule')}
      >
        <Trash2 size={13} />
      </Button>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────

interface NotificationRuleListProps {
  rules: NotificationRule[];
  templates: NotificationTemplate[];
  loading: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onCreate: (rule: Omit<NotificationRule, 'id' | 'created_at' | 'updated_at'>) => void;
}

const NotificationRuleList = ({
  rules, templates, loading, onToggle, onDelete, onCreate,
}: NotificationRuleListProps) => {
  const { t } = useTranslation();
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{t('teamSettings.notificationRules')}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{t('notificationRules.listDescription')}</p>
        </div>
        <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setShowAdd(true)}>
          <Plus size={12} />
          {t('notificationRules.addRule')}
        </Button>
      </div>

      <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Settings size={14} className="animate-spin mr-2" />{t('common.loading')}
          </div>
        ) : rules.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t('notificationRules.empty')}
          </div>
        ) : (
          rules.map(rule => (
            <RuleRow
              key={rule.id}
              rule={rule}
              templates={templates}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))
        )}
      </div>

      <AddRuleDialog
        open={showAdd}
        templates={templates}
        onClose={() => setShowAdd(false)}
        onCreate={onCreate}
      />
    </div>
  );
};

export default NotificationRuleList;