import { useState, useEffect, useRef } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useNotificationTemplates, resolveTemplate } from '@/hooks/useNotificationTemplates';
import type { EventType, Tone, NotificationTemplate } from '@/lib/notificationQueries';
import {
  NOTIF_GROUPS,
  getNotifLabel, getNotifGroupLabel,
  notifToDisplay, notifToStorage,
} from '@/lib/templateVariables';

const EVENT_LABELS: Record<EventType, string> = {
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

const TONE_LABELS: Record<Tone, string> = {
  neutral: '中性',
  celebration: '慶祝 🎉',
  urgent: '緊急 🚨',
  warning: '警告 ⚠️',
  friendly: '友善 😊',
};

const EVENT_TYPES = Object.entries(EVENT_LABELS) as [EventType, string][];
const TONE_TYPES = Object.entries(TONE_LABELS) as [Tone, string][];

/** Default content per event (storage format) */
const DEFAULT_CONTENT: Record<EventType, string> = {
  task_created:       '📋 {{assigner_name}} 建立了新任務「{{task_name}}」｜指派：{{assignee}}｜優先級：{{priority}}｜截止日：{{due_date}}',
  status_changed:     '🔄 任務「{{task_name}}」的狀態已從「{{prev_status}}」變更為「{{status}}」。變更人：{{changer_name}}',
  assignee_changed:   '👋 {{assignee}} 你好，{{assigner_name}} 已將任務「{{task_name}}」指派給你。優先級：{{priority}}，截止日：{{due_date}}。請盡快處理。',
  due_reminder:       '⚠️ 提醒：「{{task_name}}」即將到期（剩餘 {{due_remaining}} 天）｜負責人：{{assignee}}',
  overdue:            '🚨 「{{task_name}}」已逾期 {{overdue_days}} 天！｜負責人：{{assignee}}',
  approval_requested: '⏳ {{requester_name}} 提交了任務「{{task_name}}」的簽核請求，請前往簽核頁面審核。',
  approval_completed: '✅ 「{{task_name}}」簽核已完成｜簽核人：{{approver_name}}',
  comment_added:      '💬 「{{task_name}}」有新評論｜來自 {{reporter}}',
  custom:             '📢 {{task_name}}',
};

const MOCK_CTX = {
  task_name: '實作登入功能',
  assignee: '陳小明',
  reporter: '王大明',
  project_name: 'LIVO',
  status: '進行中',
  prev_status: '待處理',
  priority: '高',
  due_date: '2026-04-10',
  due_remaining: '8天',
  overdue_days: '0',
  task_url: 'https://livo-tw.com/demo/task/123',
};

interface FormState {
  name: string;
  event_type: EventType;
  tone: Tone;
  template_content: string; // DISPLAY format in the form
  is_default: boolean;
}

const TemplateManager = () => {
  const { templates, loading, fetchTemplates, createTemplate, updateTemplate, deleteTemplate } = useNotificationTemplates();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({
    name: '',
    event_type: 'status_changed',
    tone: 'neutral',
    template_content: notifToDisplay(DEFAULT_CONTENT['status_changed']),
    is_default: false,
  });
  const [saving, setSaving] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void fetchTemplates();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => {
    setEditingId(null);
    setForm({
      name: '',
      event_type: 'status_changed',
      tone: 'neutral',
      template_content: notifToDisplay(DEFAULT_CONTENT['status_changed']),
      is_default: false,
    });
    setDialogOpen(true);
  };

  const openEdit = (tmpl: NotificationTemplate) => {
    setEditingId(tmpl.id);
    setForm({
      name: tmpl.name,
      event_type: tmpl.event_type,
      tone: tmpl.tone,
      template_content: notifToDisplay(tmpl.template_content),
      is_default: tmpl.is_default,
    });
    setDialogOpen(true);
  };

  const handleEventChange = (newType: EventType) => {
    const prevDefault = notifToDisplay(DEFAULT_CONTENT[form.event_type]);
    setForm(f => {
      const newForm = { ...f, event_type: newType };
      if (!f.template_content || f.template_content === prevDefault) {
        newForm.template_content = notifToDisplay(DEFAULT_CONTENT[newType]);
      }
      return newForm;
    });
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.template_content.trim()) return;
    setSaving(true);
    const storageContent = notifToStorage(form.template_content);
    if (editingId) {
      await updateTemplate(editingId, {
        name: form.name,
        event_type: form.event_type,
        tone: form.tone,
        template_content: storageContent,
        is_default: form.is_default,
      });
    } else {
      await createTemplate({
        name: form.name,
        event_type: form.event_type,
        tone: form.tone,
        template_content: storageContent,
        is_default: form.is_default,
        created_by: null,
      });
    }
    setSaving(false);
    setDialogOpen(false);
  };

  const handleDelete = async (id: string) => {
    await deleteTemplate(id);
    setDeleteConfirmId(null);
  };

  const insertVariable = (displayVar: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const newContent = form.template_content.slice(0, start) + displayVar + form.template_content.slice(end);
    setForm(f => ({ ...f, template_content: newContent }));
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + displayVar.length;
      ta.focus();
    });
  };

  const preview = resolveTemplate(notifToStorage(form.template_content), MOCK_CTX);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <Button size="sm" className="gap-1.5" onClick={openCreate}>
          <Plus size={14} />
          新增範本
        </Button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">載入中…</div>
      ) : templates.length === 0 ? (
        <div className="text-sm text-muted-foreground py-10 text-center border border-dashed border-border rounded-lg bg-muted/10">
          尚無訊息範本，點擊「新增範本」建立第一個範本。
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {templates.map(tmpl => (
            <div
              key={tmpl.id}
              className="border border-border rounded-lg p-4 bg-muted/20 space-y-2 hover:border-primary/40 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm truncate">{tmpl.name}</span>
                    {tmpl.is_default && (
                      <Badge variant="secondary" className="text-xs">預設</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <Badge variant="outline" className="text-xs font-normal">
                      {EVENT_LABELS[tmpl.event_type] ?? tmpl.event_type}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {TONE_LABELS[tmpl.tone] ?? tmpl.tone}
                    </span>
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    onClick={() => openEdit(tmpl)}
                  >
                    <Pencil size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteConfirmId(tmpl.id)}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2 bg-muted/40 rounded px-2 py-1.5">
                {notifToDisplay(tmpl.template_content)}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Edit / Create dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? '編輯訊息範本' : '新增訊息範本'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">範本名稱</Label>
              <Input
                className="h-8 text-sm"
                placeholder="例：任務完成通知"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">事件類型</Label>
                <Select
                  value={form.event_type}
                  onValueChange={v => handleEventChange(v as EventType)}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EVENT_TYPES.map(([v, l]) => (
                      <SelectItem key={v} value={v}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">語氣</Label>
                <Select
                  value={form.tone}
                  onValueChange={v => setForm(f => ({ ...f, tone: v as Tone }))}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TONE_TYPES.map(([v, l]) => (
                      <SelectItem key={v} value={v}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">範本內容</Label>
              <Textarea
                ref={textareaRef}
                className="text-sm resize-none min-h-[80px]"
                placeholder="例：任務【任務名稱】已由【經辦人】移至【狀態】"
                value={form.template_content}
                onChange={e => setForm(f => ({ ...f, template_content: e.target.value }))}
              />
              {/* Grouped variable insertion buttons */}
              <div className="space-y-2 pt-1">
                {NOTIF_GROUPS.map(({ group, keys }) => (
                  <div key={group}>
                    <span className="text-[9px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
                      {getNotifGroupLabel(group)}
                    </span>
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {keys.map(k => (
                        <button
                          key={k}
                          type="button"
                          className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
                          onClick={() => insertVariable(`【${getNotifLabel(k)}】`)}
                        >
                          <Plus size={8} className="shrink-0 opacity-60" />
                          {getNotifLabel(k)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {form.template_content && (
              <>
                <Separator />
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">預覽（模擬資料）</Label>
                  <div className="text-sm bg-muted/40 border border-border rounded-lg px-3 py-2 text-muted-foreground">
                    {preview}
                  </div>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving || !form.name.trim() || !form.template_content.trim()}
            >
              {saving ? '儲存中…' : editingId ? '儲存' : '建立範本'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>刪除範本</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            確定要刪除此範本嗎？已綁定此範本的規則將改為預設訊息。
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirmId(null)}>取消</Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => deleteConfirmId && void handleDelete(deleteConfirmId)}
            >
              刪除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TemplateManager;
