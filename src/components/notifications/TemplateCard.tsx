import { useUIContext } from '@/context/UIContext';
import { isEventEnabled, isNotificationVariableEnabled } from '@/lib/featureToggles';
import { useState, useRef, useCallback, useEffect } from 'react';
import { Trash2, Edit2, Check, X, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { resolveTemplate } from '@/hooks/useNotificationTemplates';
import type { NotificationTemplate, EventType, Tone } from '@/lib/notificationQueries';
import {
  NOTIF_VAR_KEYS, NOTIF_GROUPS,
  getNotifLabel, getNotifGroupLabel,
  notifToDisplay, notifToStorage,
} from '@/lib/templateVariables';

export const EVENT_LABELS: Record<EventType, string> = {
  task_created:       '任務建立',
  status_changed:     '狀態變更',
  assignee_changed:   '負責人變更',
  due_reminder:       '到期提醒',
  overdue:            '任務逾期',
  approval_requested: '請求簽核',
  approval_completed: '簽核完成',
  comment_added:      '新增留言',
  custom:             '自訂',
};

export const TONE_LABELS: Record<Tone, string> = {
  neutral:     '中性',
  celebration: '慶祝',
  urgent:      '緊急',
  warning:     '警示',
  friendly:    '親和',
};

/** Variable keys used in notification templates */
export const VARIABLE_KEYS = NOTIF_VAR_KEYS;

/** Wrapped form: {{key}} */
export const VARIABLES = NOTIF_VAR_KEYS.map(k => `{{${k}}}`);

export const PREVIEW_CTX = {
  task_name:           '實作登入功能',
  task_url:            'https://livo-tw.com/demo/?task=123',
  assignee:            '陳小明',
  reporter:            '林小華',
  project_name:        'LIVO v2',
  status:              '進行中',
  prev_status:         '待處理',
  priority:            'high',
  due_date:            '2026-04-10',
  due_remaining:       '8',
  overdue_days:        '2',
  description_summary: '實作 Google OAuth 和 Email 登入流程',
  approver:            '王經理',
  subtask_progress:    '3/5',
  assigner_name:       '林小華',
  changer_name:        '陳小明',
  requester_name:      '陳小明',
  approver_name:       '王經理',
};

/** Default template content per event type (storage format) */
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

/** Insert text at cursor position in a textarea */
function insertAtCursor(textarea: HTMLTextAreaElement | null, text: string, setValue: (fn: (prev: string) => string) => void) {
  if (!textarea) {
    setValue(prev => prev + text);
    return;
  }
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  setValue(prev => prev.slice(0, start) + text + prev.slice(end));
  requestAnimationFrame(() => {
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.focus();
  });
}

// ── Autocomplete hook for 【 trigger ──────────────────────────

function useVariableAutocomplete(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  setValue: (fn: (prev: string) => string) => void,
) {
  const { approvalsEnabled } = useUIContext();
  const availableKeys = NOTIF_VAR_KEYS.filter(key => isNotificationVariableEnabled(key, approvalsEnabled));
  const [show, setShow] = useState(false);
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  const filtered = filter
    ? availableKeys.filter(k => getNotifLabel(k).includes(filter) || k.includes(filter.toLowerCase()))
    : availableKeys;

  // Detect 【 typed in textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const handler = () => {
      const pos = ta.selectionStart;
      const before = ta.value.slice(0, pos);
      const match = before.match(/【([^】]*)$/);
      if (match) {
        setShow(true);
        setFilter(match[1]);
        setSelectedIdx(0);
      } else {
        setShow(false);
      }
    };
    ta.addEventListener('input', handler);
    ta.addEventListener('click', handler);
    return () => { ta.removeEventListener('input', handler); ta.removeEventListener('click', handler); };
  }, [textareaRef, value]);

  const accept = useCallback((key: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const match = before.match(/【([^】]*)$/);
    if (match) {
      const start = pos - match[0].length;
      const label = getNotifLabel(key as any);
      const display = `【${label}】`;
      setValue(prev => prev.slice(0, start) + display + prev.slice(pos));
      requestAnimationFrame(() => {
        const newPos = start + display.length;
        ta.selectionStart = ta.selectionEnd = newPos;
        ta.focus();
      });
    }
    setShow(false);
  }, [textareaRef, setValue]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!show || filtered.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => (i + 1) % filtered.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => (i - 1 + filtered.length) % filtered.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(filtered[selectedIdx]); }
    else if (e.key === 'Escape') { setShow(false); }
  }, [show, filtered, selectedIdx, accept]);

  return { show, filtered, selectedIdx, accept, onKeyDown };
}

// ── Autocomplete Dropdown ─────────────────────────────────────

function AutocompleteDropdown({ ac, id }: { ac: ReturnType<typeof useVariableAutocomplete>; id?: string }) {
  if (!ac.show || ac.filtered.length === 0) return null;
  return (
    <div id={id} role="listbox" aria-label="Template variables" className="absolute z-50 left-0 right-0 top-full mt-1 bg-popover border border-border rounded-md shadow-lg max-h-40 overflow-y-auto">
      {ac.filtered.map((k, i) => (
        <button
          key={k}
          id={id ? `${id}-opt-${k}` : undefined}
          role="option"
          aria-selected={i === ac.selectedIdx}
          type="button"
          onMouseDown={e => { e.preventDefault(); ac.accept(k); }}
          className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${i === ac.selectedIdx ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50'}`}
        >
          <span className="font-medium text-primary shrink-0">【{getNotifLabel(k)}】</span>
          <span className="text-muted-foreground truncate text-[10px] font-mono">{k}</span>
        </button>
      ))}
    </div>
  );
}

// ── Grouped Variable Buttons ──────────────────────────────────

function GroupedVariableButtons({ onInsert, compact }: { onInsert: (displayVar: string) => void; compact?: boolean }) {
  const { approvalsEnabled } = useUIContext();
  const groups = NOTIF_GROUPS.map(group => ({
    ...group, keys: group.keys.filter(key => isNotificationVariableEnabled(key, approvalsEnabled)),
  })).filter(group => group.keys.length > 0);
  const { t } = useTranslation();

  if (compact) {
    return (
      <div className="space-y-1.5">
        {groups.map(({ group, keys }) => (
          <div key={group}>
            <span className="text-[9px] font-medium text-muted-foreground/70 uppercase tracking-wider">{getNotifGroupLabel(group)}</span>
            <div className="flex flex-wrap gap-1 mt-0.5">
              {keys.map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => onInsert(`【${getNotifLabel(k)}】`)}
                  className="inline-flex items-center gap-0.5 text-[10px] bg-primary/10 hover:bg-primary/20 text-primary rounded px-1.5 py-0.5 transition-colors cursor-pointer"
                >
                  <Plus size={8} className="shrink-0 opacity-60" />
                  {getNotifLabel(k)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden">
      <div className="px-2.5 py-1.5 bg-muted/50 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        {t('templateVar.title')}
      </div>
      <div className="p-2 space-y-2 max-h-48 overflow-y-auto">
        {groups.map(({ group, keys }) => (
          <div key={group}>
            <div className="text-[9px] font-semibold text-muted-foreground/70 uppercase tracking-wider mb-1">
              {getNotifGroupLabel(group)}
            </div>
            <div className="flex flex-wrap gap-1">
              {keys.map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => onInsert(`【${getNotifLabel(k)}】`)}
                  className="inline-flex items-center gap-1 text-[11px] bg-primary/10 hover:bg-primary/20 text-primary rounded-md px-2 py-1 transition-colors cursor-pointer group"
                >
                  <Plus size={10} className="shrink-0 opacity-50 group-hover:opacity-100" />
                  {getNotifLabel(k)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Keep the old VariableTable export name for backward compat
export { GroupedVariableButtons as VariableTable };

// ── TemplateCard (inline-editable row) ──────────────────────────

interface TemplateCardProps {
  template: NotificationTemplate;
  onUpdate: (id: string, patch: Partial<NotificationTemplate>) => void;
  onDelete: (id: string) => void;
}

export function TemplateCard({ template, onUpdate, onDelete }: TemplateCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  // Draft is in DISPLAY format (【label】)
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const startEdit = () => {
    setDraft(notifToDisplay(template.template_content));
    setEditing(true);
  };

  const save = () => {
    // Convert display → storage before saving
    onUpdate(template.id, { template_content: notifToStorage(draft) });
    setEditing(false);
  };
  const cancel = () => { setDraft(''); setEditing(false); };

  const handleInsert = useCallback((displayVar: string) => {
    insertAtCursor(textareaRef.current, displayVar, setDraft);
  }, []);

  const ac = useVariableAutocomplete(textareaRef, draft, setDraft);

  // For preview, convert display→storage first, then resolve
  const previewContent = draft ? resolveTemplate(notifToStorage(draft), PREVIEW_CTX) : '';

  return (
    <div className="px-4 py-3 space-y-1.5 hover:bg-muted/20 transition-colors">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-xs bg-muted text-muted-foreground rounded px-1.5 py-0.5 shrink-0">
            {EVENT_LABELS[template.event_type] ?? template.event_type}
          </span>
          <span className="text-sm font-medium truncate">{template.name}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {TONE_LABELS[template.tone as Tone] ?? template.tone}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {editing ? (
            <>
              <Button variant="ghost" size="icon" className="h-6 w-6 text-green-600" onClick={save} aria-label="儲存">
                <Check size={12} />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={cancel} aria-label="取消">
                <X size={12} />
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground" onClick={startEdit} aria-label="編輯範本">
                <Edit2 size={12} />
              </Button>
              {!template.is_default && (
                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => onDelete(template.id)} aria-label="刪除範本">
                  <Trash2 size={12} />
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <div className="relative">
            <textarea
              ref={textareaRef}
              className="w-full text-xs bg-muted/40 border border-border rounded px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              rows={4}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={ac.onKeyDown}
              placeholder={t('notificationTemplate.contentPlaceholder')}
              aria-expanded={ac.show && ac.filtered.length > 0}
              aria-controls={ac.show ? 'tc-ac-edit' : undefined}
              aria-activedescendant={ac.show && ac.filtered.length > 0 ? `tc-ac-edit-opt-${ac.filtered[ac.selectedIdx]}` : undefined}
            />
            <AutocompleteDropdown ac={ac} id="tc-ac-edit" />
          </div>
          <GroupedVariableButtons onInsert={handleInsert} compact />
          {previewContent && (
            <div className="text-xs text-muted-foreground bg-muted/40 rounded px-2 py-1.5">
              <span className="font-medium mr-1">{t('notificationTemplate.preview')}：</span>
              {previewContent}
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground line-clamp-2">
          {notifToDisplay(template.template_content)}
        </p>
      )}
    </div>
  );
}

// ── AddTemplateForm ──────────────────────────────────────────────

const EVENT_TYPES = Object.keys(EVENT_LABELS) as EventType[];
const TONES = Object.keys(TONE_LABELS) as Tone[];

interface AddTemplateFormProps {
  onAdd: (data: Omit<NotificationTemplate, 'id' | 'created_at' | 'updated_at' | 'created_by'>) => void;
  onCancel: () => void;
}

export function AddTemplateForm({ onAdd, onCancel }: AddTemplateFormProps) {
  const { approvalsEnabled } = useUIContext();
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [eventType, setEventType] = useState<EventType>('status_changed');
  const [tone, setTone] = useState<Tone>('neutral');
  // Content in DISPLAY format
  const [content, setContent] = useState(notifToDisplay(DEFAULT_CONTENT['status_changed']));
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleEventChange = (newType: EventType) => {
    const prevDefault = notifToDisplay(DEFAULT_CONTENT[eventType]);
    setEventType(newType);
    // Pre-fill default content if user hasn't customized
    if (!content || content === prevDefault) {
      setContent(notifToDisplay(DEFAULT_CONTENT[newType]));
    }
  };

  const handleInsert = useCallback((displayVar: string) => {
    insertAtCursor(textareaRef.current, displayVar, setContent);
  }, []);

  const ac = useVariableAutocomplete(textareaRef, content, setContent);

  const handleAdd = () => {
    if (!isEventEnabled(eventType, approvalsEnabled) || !name.trim() || !content.trim()) return;
    // Convert display → storage for persistence
    onAdd({ name, event_type: eventType, template_content: notifToStorage(content), tone, is_default: false, organization_id: null });
  };

  useEffect(() => {
    if (!isEventEnabled(eventType, approvalsEnabled)) {
      setEventType('status_changed');
      setContent(notifToDisplay(DEFAULT_CONTENT.status_changed));
    }
  }, [eventType, approvalsEnabled]);

  const previewContent = content ? resolveTemplate(notifToStorage(content), PREVIEW_CTX) : '';

  return (
    <div className="border border-primary/30 rounded-lg p-4 space-y-3 bg-primary/5">
      <div className="grid grid-cols-2 gap-2">
        <input
          className="h-8 col-span-2 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder={t('notificationTemplate.namePlaceholder')}
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <Select value={eventType} onValueChange={v => handleEventChange(v as EventType)}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {EVENT_TYPES.filter(event => isEventEnabled(event, approvalsEnabled)).map(e => <SelectItem key={e} value={e} className="text-xs">{EVENT_LABELS[e]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={tone} onValueChange={v => setTone(v as Tone)}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {TONES.map(t => <SelectItem key={t} value={t} className="text-xs">{TONE_LABELS[t]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Textarea */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          className="w-full text-sm bg-background border border-input rounded-md px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          rows={6}
          placeholder={t('notificationTemplate.contentPlaceholder')}
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={ac.onKeyDown}
          aria-expanded={ac.show && ac.filtered.length > 0}
          aria-controls={ac.show ? 'tc-ac-add' : undefined}
          aria-activedescendant={ac.show && ac.filtered.length > 0 ? `tc-ac-add-opt-${ac.filtered[ac.selectedIdx]}` : undefined}
        />
        <AutocompleteDropdown ac={ac} id="tc-ac-add" />
      </div>

      {/* Grouped variable buttons */}
      <GroupedVariableButtons onInsert={handleInsert} />

      {/* Preview */}
      {previewContent && (
        <div className="text-xs text-muted-foreground bg-muted/40 rounded px-3 py-2">
          <span className="font-medium mr-1">{t('notificationTemplate.preview')}：</span>
          {previewContent}
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button size="sm" className="h-7 text-xs" onClick={handleAdd} disabled={!name.trim() || !content.trim()}>
          {t('common.add')}
        </Button>
      </div>
    </div>
  );
}

export default TemplateCard;
