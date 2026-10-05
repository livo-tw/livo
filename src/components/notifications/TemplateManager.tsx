import { useUIContext } from '@/context/UIContext';
import { isEventEnabled } from '@/lib/featureToggles';
import { useState, useEffect, useRef } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
import {
  EVENT_TYPES, TONES,
  eventLabel, toneLabel,
  getDefaultContent, buildPreviewContext,
} from './notificationLabels';

/** Emoji shown after the tone label */
const TONE_EMOJI: Record<Tone, string> = {
  neutral: '',
  celebration: ' 🎉',
  urgent: ' 🚨',
  warning: ' ⚠️',
  friendly: ' 😊',
};

interface FormState {
  name: string;
  event_type: EventType;
  tone: Tone;
  template_content: string; // DISPLAY format in the form
  is_default: boolean;
}

const TemplateManager = () => {
  const { t } = useTranslation();
  const { approvalsEnabled } = useUIContext();
  const { templates, loading, fetchTemplates, createTemplate, updateTemplate, deleteTemplate } = useNotificationTemplates();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => ({
    name: '',
    event_type: 'status_changed',
    tone: 'neutral',
    template_content: notifToDisplay(getDefaultContent(t, 'status_changed')),
    is_default: false,
  }));
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
      template_content: notifToDisplay(getDefaultContent(t, 'status_changed')),
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
    const prevDefault = notifToDisplay(getDefaultContent(t, form.event_type));
    const nextDefault = notifToDisplay(getDefaultContent(t, newType));
    setForm(f => {
      const newForm = { ...f, event_type: newType };
      if (!f.template_content || f.template_content === prevDefault) {
        newForm.template_content = nextDefault;
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

  const preview = resolveTemplate(notifToStorage(form.template_content), buildPreviewContext(t));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <Button size="sm" className="gap-1.5" onClick={openCreate}>
          <Plus size={14} />
          {t('notificationRules.templates.add')}
        </Button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">{t('common.loading')}</div>
      ) : templates.length === 0 ? (
        <div className="text-sm text-muted-foreground py-10 text-center border border-dashed border-border rounded-lg bg-muted/10">
          {t('notificationRules.templates.empty')}
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
                      <Badge variant="secondary" className="text-xs">{t('notificationRules.default')}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <Badge variant="outline" className="text-xs font-normal">
                      {eventLabel(t, tmpl.event_type)}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {toneLabel(t, tmpl.tone)}{TONE_EMOJI[tmpl.tone] ?? ''}
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
      <Dialog open={dialogOpen && isEventEnabled(form.event_type, approvalsEnabled)} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? t('notificationRules.templates.editTitle') : t('notificationRules.templates.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('notificationRules.templates.name')}</Label>
              <Input
                className="h-8 text-sm"
                placeholder={t('notificationRules.templates.namePlaceholder')}
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{t('notificationRules.eventType')}</Label>
                <Select
                  value={form.event_type}
                  onValueChange={v => handleEventChange(v as EventType)}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EVENT_TYPES.filter(event => isEventEnabled(event, approvalsEnabled)).map(v => (
                      <SelectItem key={v} value={v}>{eventLabel(t, v)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('notificationRules.templates.tone')}</Label>
                <Select
                  value={form.tone}
                  onValueChange={v => setForm(f => ({ ...f, tone: v as Tone }))}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TONES.map(v => (
                      <SelectItem key={v} value={v}>{toneLabel(t, v)}{TONE_EMOJI[v]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t('notificationRules.templates.content')}</Label>
              <Textarea
                ref={textareaRef}
                className="text-sm resize-none min-h-[80px]"
                placeholder={t('notificationRules.templates.contentPlaceholder', {
                  task: `【${getNotifLabel('task_name')}】`,
                  assignee: `【${getNotifLabel('assignee')}】`,
                  status: `【${getNotifLabel('status')}】`,
                })}
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
                  <Label className="text-xs text-muted-foreground">{t('notificationRules.templates.previewSample')}</Label>
                  <div className="text-sm bg-muted/40 border border-border rounded-lg px-3 py-2 text-muted-foreground">
                    {preview}
                  </div>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving || !form.name.trim() || !form.template_content.trim()}
            >
              {saving ? t('common.saving') : editingId ? t('common.save') : t('notificationRules.templates.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('notificationRules.templates.delete')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            {t('notificationRules.templates.deleteConfirm')}
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirmId(null)}>{t('common.cancel')}</Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => deleteConfirmId && void handleDelete(deleteConfirmId)}
            >
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TemplateManager;
