import { format, parseISO } from 'date-fns';
import { FileText, RefreshCw, Copy, Save, ChevronLeft, ChevronRight, Clock, Check, Send } from 'lucide-react';
import { ReportType, TAB_LABELS, getTabLabels, shiftAnchor } from './types';
import { WorkReport } from './types';
import { useTranslation } from 'react-i18next';

interface WorkReportEditorProps {
  reportType: ReportType;
  onTabChange: (type: ReportType) => void;
  anchor: Date;
  onShiftAnchor: (dir: -1 | 1) => void;
  title: string;
  savedReport: WorkReport | null;
  content: string;
  onContentChange: (v: string) => void;
  loading: boolean;
  saving: boolean;
  saveStatus: 'idle' | 'saving' | 'saved';
  showHistory: boolean;
  onToggleHistory: () => void;
  onGenerate: () => void;
  onSave: () => void;
  onCopy: () => void;
  onSend?: () => void;
}

const WorkReportEditor = ({
  reportType, onTabChange, anchor, onShiftAnchor,
  title, savedReport, content, onContentChange,
  loading, saving, saveStatus,
  showHistory, onToggleHistory,
  onGenerate, onSave, onCopy, onSend,
}: WorkReportEditorProps) => {
  const { t } = useTranslation();
  const tabLabels = getTabLabels();
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* Tabs */}
      <div className="flex border-b border-border">
        {(Object.keys(TAB_LABELS) as ReportType[]).map(type => (
          <button
            key={type}
            onClick={() => onTabChange(type)}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors flex items-center justify-center gap-1.5 ${
              reportType === type
                ? 'border-b-2 border-primary text-primary bg-primary/5'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <FileText size={14} />
            {tabLabels[type]}
          </button>
        ))}
      </div>

      <div className="p-4 space-y-4">
        {/* Period navigator */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => onShiftAnchor(-1)}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft size={18} />
          </button>
          <div className="flex flex-col items-center">
            <span className="text-base font-semibold text-foreground">{title}</span>
            {savedReport && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                <Clock size={10} />
                {t('workReport.editor.lastSaved')}{format(parseISO(savedReport.updatedAt), 'MM/dd HH:mm')}
                {savedReport.isEdited && ` (${t('workReport.editedBadge')})`}
              </span>
            )}
          </div>
          <button
            onClick={() => onShiftAnchor(1)}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          >
            <ChevronRight size={18} />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={onGenerate}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <RefreshCw size={14} />
            {content ? t('workReport.regenerate') : t('workReport.generate')}
          </button>
          <button
            onClick={onCopy}
            disabled={!content.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-40"
          >
            <Copy size={14} />
            {t('workReport.editor.copy')}
          </button>
          <button
            onClick={onSave}
            disabled={saving || !content.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-40"
          >
            <Save size={14} />
            {saving ? t('workReport.editor.saving') : t('workReport.editor.save')}
          </button>
          <button
            onClick={onToggleHistory}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
              showHistory ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground hover:bg-accent'
            }`}
          >
            {t('workReport.editor.history')}
          </button>
          {onSend && (
            <button
              onClick={onSend}
              disabled={!content.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-primary text-primary text-sm font-medium hover:bg-primary/10 transition-colors disabled:opacity-40"
            >
              <Send size={14} />
              {t('workReport.editor.send')}
            </button>
          )}
          {saveStatus === 'saving' && (
            <span className="text-xs text-muted-foreground ml-1 animate-pulse">{t('workReport.editor.saving')}</span>
          )}
          {saveStatus === 'saved' && (
            <span className="text-xs text-green-500 ml-1 flex items-center gap-1">
              <Check size={12} /> {t('workReport.editor.saved')}
            </span>
          )}
        </div>

        {/* Content area */}
        {loading ? (
          <div className="text-center py-8 text-sm text-muted-foreground">{t('workReport.editor.loading')}</div>
        ) : (
          <div>
            <textarea
              value={content}
              onChange={e => onContentChange(e.target.value)}
              placeholder={t('workReport.editor.placeholder', { type: tabLabels[reportType] })}
              className="w-full min-h-[280px] border border-border rounded-lg px-4 py-3 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={onGenerate}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {loading ? t('workReport.editor.generating') : t('workReport.generate')}
          </button>
          <button
            onClick={onSave}
            disabled={saving || !content.trim()}
            className="px-4 py-2 text-sm font-medium border border-border rounded-lg hover:bg-accent transition-colors disabled:opacity-50"
          >
            {saving ? t('workReport.editor.saving') : t('workReport.editor.save')}
          </button>
          <button
            onClick={onCopy}
            disabled={!content.trim()}
            className="px-4 py-2 text-sm font-medium border border-border rounded-lg hover:bg-accent transition-colors disabled:opacity-50"
          >
            {t('workReport.editor.copy')}
          </button>
          <button
            onClick={onSend}
            disabled={!content.trim()}
            className="px-4 py-2 text-sm font-medium border border-border rounded-lg hover:bg-accent transition-colors disabled:opacity-50"
          >
            {t('workReport.editor.send')}
          </button>
          <button
            onClick={onToggleHistory}
            className="ml-auto px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {showHistory ? t('workReport.editor.hideHistory') : t('workReport.editor.history')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default WorkReportEditor;