import { useUIContext } from '@/context/UIContext';
import { isEventEnabled } from '@/lib/featureToggles';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { EventType, NotificationTemplate } from '@/lib/notificationQueries';
import { RULE_EVENT_TYPES, eventLabel } from './notificationLabels';

export interface NewRuleForm {
  event_type: EventType;
  from_status: string;
  to_status: string;
  template_id: string;
  channel_type: string;
  channel_target: string;
  auto_send: boolean;
  auto_send_delay_seconds: number;
}

export const EMPTY_FORM: NewRuleForm = {
  event_type: 'status_changed',
  from_status: '',
  to_status: '',
  template_id: '',
  channel_type: 'slack',
  channel_target: '',
  auto_send: true,
  auto_send_delay_seconds: 3,
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: NotificationTemplate[];
  statusNames: string[];
  onSubmit: (form: NewRuleForm) => Promise<void>;
}

export function AddRuleDialog({ open, onOpenChange, templates, statusNames, onSubmit }: Props) {
  const { t } = useTranslation();
  const { approvalsEnabled } = useUIContext();
  const [form, setForm] = useState<NewRuleForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    setSaving(true);
    await onSubmit(form);
    setSaving(false);
    onOpenChange(false);
    setForm(EMPTY_FORM);
  };

  return (
    <Dialog open={open && isEventEnabled(form.event_type, approvalsEnabled)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('notificationRules.dialog.addTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('notificationRules.eventType')}</Label>
            <Select
              value={form.event_type}
              onValueChange={v => setForm(f => ({ ...f, event_type: v as EventType, from_status: '', to_status: '' }))}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_EVENT_TYPES.filter(event => isEventEnabled(event, approvalsEnabled)).map(v => (
                  <SelectItem key={v} value={v}>{eventLabel(t, v)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.event_type === 'status_changed' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{t('notificationRules.dialog.fromStatus')}</Label>
                <Select
                  value={form.from_status}
                  onValueChange={v => setForm(f => ({ ...f, from_status: v === '__any__' ? '' : v }))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={t('notificationRules.any')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__any__">{t('notificationRules.any')}</SelectItem>
                    {statusNames.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('notificationRules.dialog.toStatus')}</Label>
                <Select
                  value={form.to_status}
                  onValueChange={v => setForm(f => ({ ...f, to_status: v === '__any__' ? '' : v }))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={t('notificationRules.any')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__any__">{t('notificationRules.any')}</SelectItem>
                    {statusNames.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">{t('notificationRules.dialog.template')}</Label>
            <Select
              value={form.template_id}
              onValueChange={v => setForm(f => ({ ...f, template_id: v === '__none__' ? '' : v }))}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={t('notificationRules.dialog.templateDefault')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t('notificationRules.dialog.templateDefault')}</SelectItem>
                {templates.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('notificationRules.dialog.channelType')}</Label>
              <Select
                value={form.channel_type}
                onValueChange={v => setForm(f => ({ ...f, channel_type: v }))}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="slack">Slack</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('notificationRules.dialog.channelTarget')}</Label>
              <Input
                className="h-8 text-xs"
                placeholder="#general"
                value={form.channel_target}
                onChange={e => setForm(f => ({ ...f, channel_target: e.target.value }))}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch
                id="auto-send"
                checked={form.auto_send}
                onCheckedChange={v => setForm(f => ({ ...f, auto_send: v }))}
              />
              <Label htmlFor="auto-send" className="text-xs cursor-pointer">{t('notificationRules.autoSend')}</Label>
            </div>
            {form.auto_send && (
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">{t('notificationRules.dialog.delay')}</Label>
                <Input
                  type="number"
                  min={1}
                  max={30}
                  className="h-8 text-xs w-16"
                  value={form.auto_send_delay_seconds}
                  onChange={e => setForm(f => ({ ...f, auto_send_delay_seconds: Number(e.target.value) }))}
                />
                <span className="text-xs text-muted-foreground">{t('common.seconds')}</span>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button size="sm" onClick={handleCreate} disabled={!form.event_type || saving}>
            {saving ? t('common.saving') : t('common.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AddRuleDialog;
