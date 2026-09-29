import { Lock } from 'lucide-react';
import UserSelect from '@/components/UserSelect';
import type { CustomField, TaskCustomFieldValue } from '@/types';
import type { OtherViewer } from '../hooks/types';

interface Props {
  field: CustomField;
  cv: TaskCustomFieldValue | undefined;
  isLocked: boolean;
  locker: OtherViewer | undefined;
  onChange: (partial: Partial<TaskCustomFieldValue>) => void;
  onFocus: () => void;
  onBlur: () => void;
}

const LockIndicator = ({ locker }: { locker: OtherViewer }) => (
  <span className="text-[10px] text-orange-500 animate-pulse flex items-center gap-1">
    <Lock size={10} /> {locker.name}
  </span>
);

const FieldLabel = ({ field, isLocked, locker }: { field: CustomField; isLocked: boolean; locker: OtherViewer | undefined }) => (
  <div className="flex items-center gap-1 mb-1">
    <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {field.fieldName}
      {field.isRequired && <span className="text-destructive ml-0.5">*</span>}
    </label>
    {isLocked && locker && <LockIndicator locker={locker} />}
  </div>
);

export const CustomFieldInput = ({ field, cv, isLocked, locker, onChange, onFocus, onBlur }: Props) => {
  const focusProps = { onFocus, onBlur };
  const labelEl = <FieldLabel field={field} isLocked={isLocked} locker={locker} />;

  if (field.fieldType === 'text') return (
    <div key={field.id}>{labelEl}
      <input type="text" value={cv?.valueText || ''} disabled={isLocked}
        onChange={e => onChange({ valueText: e.target.value || undefined })}
        placeholder={field.defaultValue || ''}
        className="w-full text-sm rounded px-2 py-1.5 outline-none bg-muted text-foreground placeholder:text-muted-foreground/50 disabled:opacity-50"
        {...focusProps} />
    </div>
  );

  if (field.fieldType === 'textarea') return (
    <div key={field.id}>{labelEl}
      <textarea value={cv?.valueText || ''} disabled={isLocked}
        onChange={e => onChange({ valueText: e.target.value || undefined })}
        placeholder={field.defaultValue || ''} rows={3}
        className="w-full text-sm rounded px-2 py-1.5 outline-none bg-muted text-foreground placeholder:text-muted-foreground/50 resize-none disabled:opacity-50"
        {...focusProps} />
    </div>
  );

  if (field.fieldType === 'number') return (
    <div key={field.id}>{labelEl}
      <input type="number" value={cv?.valueNumber !== undefined ? cv.valueNumber : ''} disabled={isLocked}
        onChange={e => onChange({ valueNumber: e.target.value !== '' ? Number(e.target.value) : undefined })}
        placeholder={field.defaultValue || ''}
        className="w-full text-sm rounded px-2 py-1.5 outline-none bg-muted text-foreground placeholder:text-muted-foreground/50 disabled:opacity-50"
        {...focusProps} />
    </div>
  );

  if (field.fieldType === 'date') return (
    <div key={field.id}>{labelEl}
      <input type="date" value={cv?.valueDate || ''} disabled={isLocked}
        onChange={e => onChange({ valueDate: e.target.value || undefined })}
        className="w-full text-sm rounded px-2 py-1.5 outline-none bg-muted text-foreground disabled:opacity-50"
        {...focusProps} />
    </div>
  );

  if (field.fieldType === 'boolean') return (
    <div key={field.id}>{labelEl}
      <label className={`flex items-center gap-2 cursor-pointer select-none ${isLocked ? 'opacity-50 pointer-events-none' : ''}`}>
        <input type="checkbox" checked={cv?.valueBoolean || false} disabled={isLocked}
          onChange={e => onChange({ valueBoolean: e.target.checked })}
          className="rounded border-border accent-primary" />
        <span className="text-sm text-foreground">{cv?.valueBoolean ? '是' : '否'}</span>
      </label>
    </div>
  );

  if (field.fieldType === 'select') return (
    <div key={field.id}>{labelEl}
      <select value={cv?.valueText || ''} disabled={isLocked}
        onChange={e => onChange({ valueText: e.target.value || undefined })}
        className="w-full text-sm rounded px-2 py-1.5 outline-none bg-muted text-foreground disabled:opacity-50"
        {...focusProps}>
        <option value="">未選擇</option>
        {(field.options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    </div>
  );

  if (field.fieldType === 'user') return (
    <div key={field.id}>{labelEl}
      <div className={isLocked ? 'opacity-50 pointer-events-none' : ''}>
        <UserSelect value={cv?.valueUserId || ''} onChange={v => onChange({ valueUserId: v || undefined })} allowEmpty emptyLabel="未指定" />
      </div>
    </div>
  );

  return null;
};
