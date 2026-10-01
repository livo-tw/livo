import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { generateId } from '@/lib/generateId';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  defaultFieldLabel, MAX_TEAM_INTRO_FIELDS, parseTeamIntroTemplate, teamIntroFieldLabel,
  type TeamIntroField, type TeamIntroTemplate,
} from '@/lib/teamIntroTemplate';

interface Props {
  initialTemplate: TeamIntroTemplate;
  onSave: (template: TeamIntroTemplate) => Promise<void>;
  onClose: () => void;
}

export default function TeamIntroTemplateEditor({ initialTemplate, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const [fields, setFields] = useState(() => initialTemplate.fields.map(field => ({ ...field, label: teamIntroFieldLabel(field, t) })));
  const [saving, setSaving] = useState(false);
  const update = (key: string, patch: Partial<TeamIntroField>) => {
    setFields(previous => previous.map(field => field.key === key ? { ...field, ...patch } : field));
  };
  const move = (index: number, direction: -1 | 1) => {
    setFields(previous => {
      const next = [...previous];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      return next;
    });
  };
  const submit = async () => {
    if (fields.some(field => !field.label.trim())) { toast.error(t('teamIntro.template.nameRequired')); return; }
    const next = parseTeamIntroTemplate({
      version: 1,
      fields: fields.map(field => ({ ...field,
        // Unchanged built-in labels keep following each reader's language.
        label: field.label.trim() === defaultFieldLabel(field.key, t) ? '' : field.label.trim(),
      })),
    });
    if (!next) { toast.error(t('teamIntro.template.invalid')); return; }
    setSaving(true);
    try {
      await onSave(next);
      toast.success(t('teamIntro.template.saved'));
      onClose();
    } catch (error) {
      toast.error(t(error instanceof Error && error.message === 'template-conflict'
        ? 'teamIntro.template.conflict' : 'teamIntro.saveFailed'));
    } finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('teamIntro.template.title')}</DialogTitle>
          <DialogDescription>{t('teamIntro.template.description')}</DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto min-h-0 space-y-3 py-1 pr-1">
          {fields.map((field, index) => (
            <fieldset key={field.key} className={`rounded-lg border p-3 space-y-3 ${field.enabled ? 'border-border' : 'border-dashed bg-muted/30'}`} disabled={saving}>
              <legend className="sr-only">{field.label || t('teamIntro.template.newField')}</legend>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground tabular-nums">{index + 1}.</span>
                <span className="text-sm font-medium flex-1 truncate">{field.label || t('teamIntro.template.newField')}</span>
                <label className="flex items-center gap-1.5 text-xs shrink-0">
                  <input type="checkbox" checked={field.enabled} onChange={event => update(field.key, { enabled: event.target.checked })} />
                  {t('teamIntro.template.enabled')}
                </label>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={saving || index === 0}
                  aria-label={t('teamIntro.template.moveUp', { name: field.label })} onClick={() => move(index, -1)}><ArrowUp size={15} /></Button>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={saving || index === fields.length - 1}
                  aria-label={t('teamIntro.template.moveDown', { name: field.label })} onClick={() => move(index, 1)}><ArrowDown size={15} /></Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`template-label-${field.key}`}>{t('teamIntro.template.fieldName')}</Label>
                  <Input id={`template-label-${field.key}`} value={field.label} maxLength={100}
                    onChange={event => update(field.key, { label: event.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`template-hint-${field.key}`}>{t('teamIntro.template.hint')}</Label>
                  <Input id={`template-hint-${field.key}`} value={field.hint} maxLength={300}
                    placeholder={t('teamIntro.template.hintPlaceholder')}
                    onChange={event => update(field.key, { hint: event.target.value })} />
                </div>
              </div>
              {field.key === 'projects' && <p className="text-xs text-muted-foreground">{t('teamIntro.template.automaticProjects')}</p>}
              {!field.enabled && <p className="text-xs text-muted-foreground">{t('teamIntro.template.disabledNote')}</p>}
            </fieldset>
          ))}
          <Button type="button" variant="outline" className="w-full" disabled={saving || fields.length >= MAX_TEAM_INTRO_FIELDS}
            onClick={() => setFields(previous => [...previous, { key: generateId('custom'), label: '', hint: '', enabled: true }])}>
            <Plus size={15} className="mr-1.5" />{t('teamIntro.template.addField')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('teamIntro.template.fieldLimit', { count: fields.length, max: MAX_TEAM_INTRO_FIELDS })}</p>
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="button" disabled={saving} onClick={() => { void submit(); }}>{t(saving ? 'common.saving' : 'common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
