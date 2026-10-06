import { useId } from 'react';
import { SearchableSelect } from '@/components/ui/searchable-select';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
export const qaInput = 'w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:opacity-60';
export const qaButton = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:cursor-not-allowed md:min-h-0 [@media(pointer:coarse)]:min-h-11';
export const qaPrimary = `${qaButton} bg-primary text-primary-foreground hover:bg-primary/90`;
export function QaField({ label, multiline, hint, ...props }: { label: string; multiline?: boolean; hint?: string } & InputHTMLAttributes<HTMLInputElement> & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  const describedBy = [props['aria-describedby'], hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  return <label htmlFor={id} className="block min-w-0 space-y-1 text-sm"><span className="font-medium">{label}{props.required ? ' *' : ''}</span>{multiline ? <textarea {...props} id={id} aria-describedby={describedBy} rows={props.rows || 3} className={qaInput} /> : <input {...props} id={id} aria-describedby={describedBy} className={qaInput} />}{hint && <span id={`${id}-hint`} className="block text-xs text-muted-foreground">{hint}</span>}</label>;
}
export function QaSelect({ label, children, ...props }: { label: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return <label htmlFor={id} className="block min-w-0 space-y-1 text-sm"><span className="font-medium">{label}{props.required ? ' *' : ''}</span><SearchableSelect {...props} id={id} className={qaInput}>{children}</SearchableSelect></label>;
}
export function QaSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-xl border border-border bg-card p-4 shadow-sm"><h2 className="mb-3 text-base font-semibold">{title}</h2>{children}</section>;
}
