import { Plus, Paperclip, FileText, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface PendingFile {
  file: File;
  preview?: string;
  id: string;
}

interface TaskFormFileUploadProps {
  pendingFiles: PendingFile[];
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemove: (id: string) => void;
  onDrop: (e: React.DragEvent) => void;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TaskFormFileUpload = ({ pendingFiles, fileInputRef, onFileSelect, onRemove, onDrop }: TaskFormFileUploadProps) => {
  const { t } = useTranslation();
  return (
    <div className="border-t border-border pt-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-1"><Paperclip size={16} /> {t('taskCreate.attachments')}</h3>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="text-sm text-primary hover:text-primary/80 flex items-center gap-1"
        >
          <Plus size={14} /> {t('common.upload')}
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar"
        onChange={onFileSelect}
        className="hidden"
      />
      <div
        onDragOver={e => e.preventDefault()}
        onDrop={onDrop}
        className="border-2 border-dashed rounded-lg p-3 md:p-4 text-center cursor-pointer hover:border-primary hover:bg-primary/5 transition-colors border-border bg-muted/30"
        onClick={() => fileInputRef.current?.click()}
      >
        <Paperclip size={18} className="mx-auto mb-1 text-muted-foreground" />
        <p className="text-xs md:text-sm text-muted-foreground" dangerouslySetInnerHTML={{ __html: t('taskCreate.dragDropFiles') }} />
      </div>
      {pendingFiles.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {pendingFiles.map(pf => (
            <div key={pf.id} className="flex items-center gap-2 p-2 rounded border border-border bg-muted/30 group">
              {pf.preview ? (
                <img src={pf.preview} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
              ) : (
                <div className="w-8 h-8 rounded bg-muted flex items-center justify-center flex-shrink-0">
                  <FileText size={14} className="text-muted-foreground" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate">{pf.file.name}</p>
                <p className="text-[11px] text-muted-foreground">{formatFileSize(pf.file.size)}</p>
              </div>
              <button
                onClick={e => { e.stopPropagation(); onRemove(pf.id); }}
                className="text-muted-foreground hover:text-destructive transition-all p-1 md:opacity-0 md:group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default TaskFormFileUpload;
