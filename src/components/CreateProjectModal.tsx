import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { generateId } from '@/lib/generateId';
import { useAuthContext } from '@/context/AuthContext';
import { useUIContext } from '@/context/UIContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useLicense } from '@/context/LicenseContext';
import { logActivity } from '@/lib/activityLog';
import { usePresenceLock } from '@/hooks/usePresenceLock';
import { useFocusTrap } from '@/hooks/useFocusTrap';

const PRESET_COLORS = ['#0065FF', '#36B37E', '#FF5630', '#6554C0', '#00B8D9', '#FF8B00', '#E774BB', '#6B778C'];

const CreateProjectModal = () => {
  const { t } = useTranslation();
  const { currentMemberId } = useAuthContext();
  const { showCreateProject, setShowCreateProject, editingProject, setEditingProject } = useUIContext();
  const { allProjects, productLines, createProjectInDb, updateProjectInDb } = useProjectContext();
  const { hasFeature } = useLicense();
  const [lineId, setLineId] = useState('');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const { viewers, trackEditing, isLockedBy, acquireLock, releaseLock } = usePresenceLock(showCreateProject ? 'project-manage-presence' : 'project-manage-inactive', !hasFeature('realtime-collab'));
  const focusTrapRef = useFocusTrap(showCreateProject);

  const isEditing = !!editingProject;
  const heldLockRef = useRef<string | null>(null);

  useEffect(() => {
    if (showCreateProject) {
      const lockKey = editingProject ? `project-${editingProject.id}` : 'project-new';
      if (editingProject) {
        setLineId(editingProject.lineId);
        setName(editingProject.name);
        setKey(editingProject.key);
        setColor(editingProject.color);
      } else {
        setLineId(productLines[0]?.id || '');
        setName('');
        setKey('');
        setColor(PRESET_COLORS[0]);
      }
      heldLockRef.current = lockKey;
      acquireLock(lockKey);
      setError('');
      setTimeout(() => nameRef.current?.focus(), 100);
    } else {
      // Release whatever lock we held (use ref to avoid stale closure)
      if (heldLockRef.current) {
        releaseLock(heldLockRef.current);
        heldLockRef.current = null;
      }
      setEditingProject(null);
    }
  }, [showCreateProject, editingProject, productLines, acquireLock, releaseLock, setEditingProject]);

  if (!showCreateProject) return null;

  const keyRegex = /^[A-Z]{2,6}$/;
  const isValid = name.trim().length > 0 && (isEditing || keyRegex.test(key));

  const handleSubmit = async () => {
    if (!isValid || isSubmitting) return;
    setIsSubmitting(true);
    try {

    if (isEditing) {
      const updates: Record<string, unknown> = {};
      if (name.trim() !== editingProject!.name) updates.name = name.trim();
      if (lineId !== editingProject!.lineId) updates.lineId = lineId;
      if (color !== editingProject!.color) updates.color = color;
      if (Object.keys(updates).length > 0) {
        await updateProjectInDb(editingProject!.id, updates);
        if (currentMemberId) {
          const changes: string[] = [];
          if (updates.name) changes.push(t('project.activityNameChanged', { oldName: editingProject!.name, newName: updates.name }));
          if (updates.lineId) {
            const oldLine = productLines.find(l => l.id === editingProject!.lineId);
            const newLine = productLines.find(l => l.id === updates.lineId);
            changes.push(t('project.activityLineChanged', { oldLine: oldLine?.name || '—', newLine: newLine?.name || '—' }));
          }
          if (updates.color) changes.push(t('project.activityColorChanged', { oldColor: editingProject!.color, newColor: updates.color }));
          await logActivity(currentMemberId, 'update_project', t('project.activityUpdated', { name: editingProject!.name, changes: changes.join('、') }), undefined, undefined, 'project');
        }
      }
      setShowCreateProject(false);
      return;
    }

    // Create new
    if (allProjects.some(p => p.key === key)) {
      setError(t('project.keyDuplicated', { key }));
      return;
    }
    if (allProjects.some(p => p.lineId === lineId && p.name === name.trim())) {
      setError(t('project.duplicateName'));
      return;
    }
    const newProject = {
      id: generateId('p'),
      lineId,
      name: name.trim(),
      key,
      color,
      isArchived: false,
    };
    await createProjectInDb(newProject);
    if (currentMemberId) await logActivity(currentMemberId, 'add_project', t('project.activityCreated', { name: name.trim(), key }), undefined, undefined, 'project');
    setShowCreateProject(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      ref={focusTrapRef}
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => setShowCreateProject(false)}
      onKeyDown={e => e.key === 'Escape' && setShowCreateProject(false)}
    >
      <div
        className="bg-card rounded-lg shadow-xl border border-border w-[min(360px,calc(100vw-32px))] mx-4"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-foreground">{isEditing ? t('project.editTitle') : t('project.createTitle')}</h2>
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

        {/* Form */}
        <div className="px-5 pb-5 space-y-4">
          {/* Product Line */}
          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1 block">{t('project.lineLabel')}</label>
            <select
              value={lineId}
              onChange={e => setLineId(e.target.value)}
              className="w-full border border-border rounded px-2.5 py-1.5 text-xs bg-card text-foreground outline-none focus:ring-1 focus:ring-primary"
            >
              {productLines.map(l => (
                <option key={l.id} value={l.id}>{l.icon} {l.name}</option>
              ))}
            </select>
          </div>

          {/* Name */}
          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1 block">{t('project.nameLabel')}</label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={e => { setName(e.target.value.slice(0, 200)); setError(''); }}
              placeholder={t('project.namePlaceholder')}
              className="w-full border border-border rounded px-2.5 py-1.5 text-xs bg-card text-foreground outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/50"
              maxLength={200}
            />
          </div>

          {/* Key - read-only when editing */}
          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1 block">{t('project.keyLabel')}</label>
            <input
              type="text"
              value={key}
              onChange={e => { setKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6)); setError(''); }}
              placeholder={t('project.keyPlaceholder')}
              disabled={isEditing}
              className={`w-full border border-border rounded px-2.5 py-1.5 text-xs bg-card text-foreground outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/50 uppercase ${isEditing ? 'opacity-50 cursor-not-allowed' : ''}`}
              maxLength={6}
            />
            {isEditing
              ? <p className="text-[10px] text-muted-foreground mt-0.5">{t('project.keyImmutable')}</p>
              : <p className="text-[10px] text-muted-foreground mt-0.5">{t('project.keyUsage')}</p>
            }
          </div>

          {/* Color */}
          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1 block">{t('project.colorLabel')}</label>
            <div className="flex gap-2">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className="w-7 h-7 rounded-md transition-all"
                  style={{
                    backgroundColor: c,
                    border: color === c ? '3px solid #172B4D' : '2px solid transparent',
                    boxShadow: color === c ? '0 0 0 1px #fff inset' : 'none',
                  }}
                />
              ))}
            </div>
          </div>

          {/* Error */}
          {error && <p className="text-[11px] text-destructive">{error}</p>}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => setShowCreateProject(false)}
              className="px-3 py-1.5 rounded text-xs font-medium text-muted-foreground hover:bg-accent transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSubmit}
              disabled={!isValid || isSubmitting}
              className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${
                isValid && !isSubmitting
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground cursor-not-allowed'
              }`}
            >
              {isSubmitting ? t('common.processing') : isEditing ? t('common.save') : t('common.create')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CreateProjectModal;
