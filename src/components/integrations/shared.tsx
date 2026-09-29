import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Loader2, ToggleLeft, ToggleRight } from 'lucide-react';

export const inputCls = 'w-full border border-border rounded px-2.5 py-1.5 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary disabled:opacity-50';

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`transition-colors ${value ? 'text-primary' : 'text-muted-foreground/40'}`}
      title={value ? t('integrations.toggleEnabled') : t('integrations.toggleDisabled')}
    >
      {value ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
    </button>
  );
}

export function EventCheckboxes({
  options, values, onChange,
}: {
  options: { value: string; labelKey: string }[];
  values: string[];
  onChange: (v: string[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {options.map(opt => (
        <label key={opt.value} className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={values.includes(opt.value)}
            onChange={e => {
              if (e.target.checked) onChange([...values, opt.value]);
              else onChange(values.filter(v => v !== opt.value));
            }}
            className="rounded"
          />
          <span className="text-sm text-foreground">{t(opt.labelKey)}</span>
        </label>
      ))}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground block">{label}</label>
      {children}
    </div>
  );
}

export function ServiceCard({
  icon, title, description, enabled, onToggle, children, onSave, saving, badge,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children: React.ReactNode;
  onSave: () => void;
  saving: boolean;
  badge?: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`border rounded-lg overflow-hidden transition-colors ${enabled ? 'border-primary/40 bg-primary/5' : 'border-border bg-card'}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className={`flex-shrink-0 ${enabled ? 'text-primary' : 'text-muted-foreground'}`}>{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-foreground">{title}</span>
            {badge && <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">{badge}</span>}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Toggle value={enabled} onChange={onToggle} />
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-border">
          <div className="pt-3 space-y-3">{children}</div>
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              {t('integrations.saveButton')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
