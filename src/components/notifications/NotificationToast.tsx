import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Send, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { resolveTemplate } from '@/hooks/useNotificationTemplates';
import type { Task } from '@/types';
import { buildNotificationContext, type NotificationRule, type NotificationTemplate } from '@/lib/notificationQueries';

interface Props {
  task: Task;
  fromStatus: string;
  toStatus: string;
  rule: NotificationRule;
  templates: NotificationTemplate[];
  onDismiss: () => void;
  sendNotification: (rule: NotificationRule, task: Task, customMessage?: string, fromStatus?: string, toStatus?: string) => Promise<void>;
}

const NotificationToast = ({ task, fromStatus, toStatus, rule, templates, onDismiss, sendNotification }: Props) => {
  const delaySeconds = rule.auto_send_delay_seconds || 3;
  const [timeLeft, setTimeLeft] = useState(delaySeconds);
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState(rule.template_id ?? '');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const autoSentRef = useRef(false);
  const messageRef = useRef('');

  // Keep message ref in sync
  useEffect(() => { messageRef.current = message; }, [message]);

  // Resolve message from template
  useEffect(() => {
    const tmpl = templates.find(t => t.id === selectedTemplateId);
    const content = tmpl?.template_content ?? task.title;
    setMessage(resolveTemplate(content, buildNotificationContext(task, fromStatus, toStatus)));
  }, [selectedTemplateId, templates, task, fromStatus, toStatus]);

  // Countdown tick
  useEffect(() => {
    if (!rule.auto_send || paused || timeLeft <= 0) return;
    const id = setTimeout(() => setTimeLeft(t => t - 1), 1000);
    return () => clearTimeout(id);
  }, [timeLeft, paused, rule.auto_send]);

  // Auto-send trigger
  useEffect(() => {
    if (timeLeft === 0 && rule.auto_send && !autoSentRef.current) {
      autoSentRef.current = true;
      void doSend(messageRef.current);
    }
  }, [timeLeft]); // eslint-disable-line react-hooks/exhaustive-deps

  const doSend = useCallback(async (msg: string) => {
    setSending(true);
    // Determine if message was customized vs. the resolved default
    const tmpl = templates.find(t => t.id === rule.template_id);
    const defaultMsg = resolveTemplate(
      tmpl?.template_content ?? task.title,
      buildNotificationContext(task, fromStatus, toStatus),
    );
    await sendNotification(rule, task, msg !== defaultMsg ? msg : undefined, fromStatus, toStatus);
    setSending(false);
    onDismiss();
  }, [templates, rule, task, fromStatus, toStatus, sendNotification, onDismiss]);

  const handleSend = () => {
    autoSentRef.current = true;
    setPaused(true);
    void doSend(message);
  };

  const handleSkip = () => {
    autoSentRef.current = true;
    onDismiss();
  };

  const handleExpand = () => {
    setPaused(true);
    setExpanded(true);
  };

  const progress = rule.auto_send
    ? ((delaySeconds - timeLeft) / delaySeconds) * 100
    : 100;

  const relevantTemplates = useMemo(
    () => templates.filter(t => t.event_type === 'status_changed' || t.event_type === rule.event_type),
    [templates, rule.event_type],
  );

  return (
    <div className="fixed bottom-4 right-4 z-50 w-96 bg-card border border-border rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 duration-300">
      {/* Auto-send progress bar */}
      {rule.auto_send && (
        <Progress value={progress} className="h-0.5 rounded-none" />
      )}

      <div className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground">
              卡片狀態變更通知
            </p>
            <p className="text-sm font-medium text-foreground truncate mt-0.5">
              「{task.title}」已移至{' '}
              <span className="text-primary">{toStatus}</span>
            </p>
            {fromStatus && (
              <p className="text-xs text-muted-foreground mt-0.5">
                從「{fromStatus}」→「{toStatus}」
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="關閉通知"
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={handleSkip}
          >
            <X size={14} />
          </Button>
        </div>

        {/* Message preview (collapsed) */}
        {!expanded && (
          <div className="text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2 line-clamp-2">
            {message || '（無預填訊息）'}
          </div>
        )}

        {/* Expanded editor */}
        {expanded && (
          <div className="space-y-2">
            {relevantTemplates.length > 0 && (
              <Select
                value={selectedTemplateId}
                onValueChange={setSelectedTemplateId}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="選擇範本…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">無範本（使用任務標題）</SelectItem>
                  {relevantTemplates.map(t => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              className="text-sm resize-none min-h-[72px]"
              placeholder="輸入通知訊息…"
            />
          </div>
        )}

        {/* Auto-send countdown hint */}
        {rule.auto_send && !paused && (
          <p className="text-xs text-muted-foreground">
            {timeLeft > 0 ? `${timeLeft} 秒後自動發送` : '正在發送…'}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={handleSkip}
          >
            跳過
          </Button>
          {!expanded && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={handleExpand}
            >
              <ChevronDown size={12} />
              編輯
            </Button>
          )}
          {expanded && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => { setPaused(false); setExpanded(false); }}
            >
              <ChevronUp size={12} />
              收起
            </Button>
          )}
          <Button
            size="sm"
            className="h-7 text-xs gap-1 ml-auto"
            onClick={handleSend}
            disabled={sending}
          >
            <Send size={12} />
            {sending ? '發送中…' : '發送'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default NotificationToast;
      