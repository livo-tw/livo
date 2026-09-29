import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { EventType, NotificationTemplate } from '@/lib/notificationQueries';

const EVENT_LABELS: Record<EventType, string> = {
  task_created: '任務建立',
  status_changed: '狀態變更',
  assignee_changed: '指派變更',
  due_reminder: '截止提醒（即將推出）',
  overdue: '已逾期（即將推出）',
  approval_requested: '請求審核',
  approval_completed: '審核完成',
  comment_added: '新增留言',
  custom: '自訂',
};

const COMING_SOON_EVENTS: EventType[] = ['due_reminder', 'overdue'];

const EVENT_TYPES = Object.entries(EVENT_LABELS) as [EventType, string][];

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>新增通知規則</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">事件類型</Label>
            <Select
              value={form.event_type}
              onValueChange={v => setForm(f => ({ ...f, event_type: v as EventType, from_status: '', to_status: '' }))}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVENT_TYPES.map(([v, l]) => (
                  <SelectItem key={v} value={v} disabled={COMING_SOON_EVENTS.includes(v)}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.event_type === 'status_changed' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">From 狀態（留空=任意）</Label>
                <Select
                  value={form.from_status}
                  onValueChange={v => setForm(f => ({ ...f, from_status: v === '__any__' ? '' : v }))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="任意" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__any__">任意</SelectItem>
                    {statusNames.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">To 狀態（留空=任意）</Label>
                <Select
                  value={form.to_status}
                  onValueChange={v => setForm(f => ({ ...f, to_status: v === '__any__' ? '' : v }))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="任意" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__any__">任意</SelectItem>
                    {statusNames.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">訊息範本</Label>
            <Select
              value={form.template_id}
              onValueChange={v => setForm(f => ({ ...f, template_id: v === '__none__' ? '' : v }))}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="預設（使用任務標題）" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">預設（使用任務標題）</SelectItem>
                {templates.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">頻道類型</Label>
              <Select
                value={form.channel_type}
                onValueChange={v => setForm(f => ({ ...f, channel_type: v }))}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="slack">Slack</SelectItem>
                  <SelectItem value="webhook" disabled>Webhook（即將推出）</SelectItem>
                  <SelectItem value="email" disabled>Email（即將推出）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">頻道目標</Label>
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
              <Label htmlFor="auto-send" className="text-xs cursor-pointer">自動發送</Label>
            </div>
            {form.auto_send && (
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">延遲</Label>
                <Input
                  type="number"
                  min={1}
                  max={30}
                  className="h-8 text-xs w-16"
                  value={form.auto_send_delay_seconds}
                  onChange={e => setForm(f => ({ ...f, auto_send_delay_seconds: Number(e.target.value) }))}
                />
                <span className="text-xs text-muted-foreground">秒</span>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
          <Button size="sm" onClick={handleCreate} disabled={!form.event_type || saving}>
            {saving ? '儲存中…' : '新增'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AddRuleDialog;