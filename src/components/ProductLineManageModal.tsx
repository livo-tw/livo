import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { generateId } from '@/lib/generateId';
import { useProjectContext } from '@/context/ProjectContext';
import { useAuthContext } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { Pencil, Check, X, Plus, Trash2, Lock } from 'lucide-react';
import { logActivity } from '@/lib/activityLog';
import { toast } from 'sonner';
import { usePresenceLock } from '@/hooks/usePresenceLock';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const PRESET_ICONS = ['📁', '🎮', '🐟', '🔧', '💼', '📊', '🎯', '🚀'];

const ProductLineManageModal = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { t } = useTranslation();
  const { productLines, createProductLineInDb, updateProductLineInDb, deleteProductLineInDb } = useProjectContext();
  const { currentMemberId, currentMember } = useAuthContext();
  const { hasFeature } = useLicense();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editIcon, setEditIcon] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState('📁');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { viewers, trackEditing, isLockedBy, acquireLock, releaseLock } = usePresenceLock(open ? 'product-line-manage-presence' : 'product-line-manage-inactive', !hasFeature('realtime-collab'));

  const canDelete = currentMember?.role === 'super_admin' || currentMember?.role === 'admin';

  useEffect(() => {
    if (editingId) setTimeout(() => inputRef.current?.focus(), 50);
  }, [editingId]);

  // Release any held lock when modal closes while editing
  const editingIdRef = useRef<string | null>(null);
  useEffect(() => { editingIdRef.current = editingId; }, [editingId]);
  useEffect(() => {
    if (!open && editingIdRef.current) {
      releaseLock(`line-${editingIdRef.current}`);
      setEditingId(null);
    }
  }, [open, releaseLock]);

  if (!open) return null;

  const startEdit = async (id: string) => {
    const { acquired, lockerName } = await acquireLock(`line-${id}`);
    if (!acquired) { toast.error(t('error.userEditing', { name: lockerName || t('common.other') })); return; }
    const line = productLines.find(l => l.id === id);
    if (!line) { releaseLock(`line-${id}`); return; }
    setEditingId(id);
    setEditName(line.name);
    setEditIcon(line.icon);
  };

  const cancelEdit = () => {
    const prevId = editingId;
    setEditingId(null);
    releaseLock(prevId ? `line-${prevId}` : undefined);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    if (!editName.trim()) {
      // Validation failed — release lock and exit edit mode
      const prevId = editingId;
      setEditingId(null);
      releaseLock(prevId ? `line-${prevId}` : undefined);
      return;
    }
    const prevId = editingId;
    const line = productLines.find(l => l.id === editingId);
    const updates: Record<string, unknown> = {};
    if (editName.trim() !== line?.name) updates.name = editName.trim();
    if (editIcon !== line?.icon) updates.icon = editIcon;
    if (Object.keys(updates).length > 0) {
      await updateProductLineInDb(editingId, updates);
      if (currentMemberId) await logActivity(currentMemberId, 'update_product_line', t('productLine.activityUpdated', { oldName: line?.name, newName: editName.trim() }), undefined, undefined, 'product_line');
    }
    setEditingId(null);
    releaseLock(prevId ? `line-${prevId}` : undefined);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const ok = await deleteProductLineInDb(deleteTarget.id);
    if (ok && currentMemberId) {
      await logActivity(currentMemberId, 'delete_product_line', t('productLine.activityDeleted', { name: deleteTarget.name }), undefined, undefined, 'product_line');
    }
    setDeleteTarget(null);
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const maxOrder = productLines.reduce((max, l) => Math.max(max, l.sortOrder), 0);
    await createProductLineInDb({
      id: generateId('pl'),
      name: newName.trim(),
      icon: newIcon,
      color: '#6B778C',
      sortOrder: maxOrder + 1,
    });
    if (currentMemberId) await logActivity(currentMemberId, 'add_product_line', t('productLine.activityCreated', { name: newName.trim() }), undefined, undefined, 'product_line');
    setNewName('');
    setNewIcon('📁');
    setShowNew(false);
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
        <div className="bg-card rounded-lg shadow-xl border border-border w-full max-w-sm" onClick={e => e.stopPropagation()}>
          <div className="px-5 pt-5 pb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-foreground">{t('productLine.manageTitle')}</h2>
              {viewers.length > 0 && (
                <div className="flex items-center gap-1">
                  {viewers.map(v => (
                    <div key={v.memberId} className="w-5 h-5 rounded-full flex items-center justify-center text-[7px] font-bold text-white" style={{ backgroundColor: v.color }} title={t('presence.viewing', { name: v.name })}>
                      {v.avatar}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X size={16} />
            </button>
          </div>
          <div className="px-5 pb-5 space-y-2">
            {productLines.map(line => (
              <div key={line.id} className="flex items-center gap-2 py-1.5">
                {editingId === line.id ? (
                  <>
                    <select
                      value={editIcon}
                      onChange={e => setEditIcon(e.target.value)}
                      className="w-10 text-center border border-border rounded bg-card text-sm py-1"
                    >
                      {PRESET_ICONS.map(ic => <option key={ic} value={ic}>{ic}</option>)}
                    </select>
                    <input
                      ref={inputRef}
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
                      className="flex-1 border border-border rounded px-2 py-1 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary"
                    />
                    <button onClick={saveEdit} className="text-primary hover:text-primary/80"><Check size={14} /></button>
                    <button onClick={cancelEdit} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
                  </>
                ) : (
                  <>
                    <span className="text-sm">{line.icon}</span>
                    <span className="flex-1 text-sm text-foreground">{line.name}</span>
                    {(() => { const locker = isLockedBy(`line-${line.id}`); return locker ? <span className="text-xs text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded animate-pulse flex items-center gap-1"><Lock size={12} /> {t('productLine.editingStatus', { name: locker.name })}</span> : null; })()}
                    <button onClick={() => startEdit(line.id)} className="text-muted-foreground hover:text-foreground">
                      <Pencil size={12} />
                    </button>
                    {canDelete && (
                      <button onClick={() => setDeleteTarget({ id: line.id, name: line.name })} className="text-muted-foreground hover:text-destructive">
                        <Trash2 size={12} />
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}

            {showNew ? (
              <div className="flex items-center gap-2 py-1.5 border-t border-border pt-3">
                <select
                  value={newIcon}
                  onChange={e => setNewIcon(e.target.value)}
                  className="w-10 text-center border border-border rounded bg-card text-sm py-1"
                >
                  {PRESET_ICONS.map(ic => <option key={ic} value={ic}>{ic}</option>)}
                </select>
                <input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowNew(false); }}
                  placeholder={t('productLine.namePlaceholder')}
                  className="flex-1 border border-border rounded px-2 py-1 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/50"
                  autoFocus
                />
                <button onClick={handleCreate} disabled={!newName.trim()} className="text-primary hover:text-primary/80 disabled:opacity-40"><Check size={14} /></button>
                <button onClick={() => setShowNew(false)} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
              </div>
            ) : (
              <button
                onClick={() => setShowNew(true)}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground pt-2"
              >
                <Plus size={14} />
                {t('productLine.addButton')}
              </button>
            )}
          </div>
        </div>
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('productLine.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('productLine.deleteConfirmMessage', { name: deleteTarget?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default ProductLineManageModal;
