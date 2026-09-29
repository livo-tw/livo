import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { NotificationTemplate } from '@/lib/notificationQueries';
import { TemplateCard, AddTemplateForm } from './TemplateCard';

interface NotificationTemplateManagerProps {
  templates: NotificationTemplate[];
  loading: boolean;
  onUpdate: (id: string, patch: Partial<NotificationTemplate>) => void;
  onDelete: (id: string) => void;
  onAdd: (data: Omit<NotificationTemplate, 'id' | 'created_at' | 'updated_at' | 'created_by'>) => void;
}

const NotificationTemplateManager = ({
  templates, loading, onUpdate, onDelete, onAdd,
}: NotificationTemplateManagerProps) => {
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">訊息範本</h3>
          <p className="text-xs text-muted-foreground mt-0.5">管理各事件的通知文案，支援變數替換</p>
        </div>
        {!showAdd && (
          <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setShowAdd(true)}>
            <Plus size={12} />
            新增範本
          </Button>
        )}
      </div>

      {showAdd && (
        <AddTemplateForm
          onAdd={data => { onAdd(data); setShowAdd(false); }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">載入中…</div>
        ) : templates.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">尚無範本</div>
        ) : (
          templates.map(t => (
            <TemplateCard key={t.id} template={t} onUpdate={onUpdate} onDelete={onDelete} />
          ))
        )}
      </div>
    </div>
  );
};

export default NotificationTemplateManager;
