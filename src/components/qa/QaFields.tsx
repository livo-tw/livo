import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
export const qaInput = 'w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60';
export const qaButton = 'inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed';
export const qaPrimary = `${qaButton} bg-primary text-primary-foreground hover:bg-primary/90`;
export function QaField({ label, multiline, ...props }: { label: string; multiline?: boolean } & InputHTMLAttributes<HTMLInputElement> & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return <label htmlFor={id} className="block min-w-0 space-y-1 text-sm"><span className="font-medium">{label}{props.required ? ' *' : ''}</span>{multiline ? <textarea {...props} id={id} rows={props.rows || 3} className={qaInput} /> : <input {...props} id={id} className={qaInput} />}</label>;
}
export function QaSelect({ label, children, ...props }: { label: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return <label htmlFor={id} className="block min-w-0 space-y-1 text-sm"><span className="font-medium">{label}{props.required ? ' *' : ''}</span><select {...props} id={id} className={qaInput}>{children}</select></label>;
}
export function QaSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-xl border border-border bg-card p-4 shadow-sm"><h2 className="mb-3 text-base font-semibold">{title}</h2>{children}</section>;
}
