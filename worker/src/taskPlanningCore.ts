/** Shared app, Slack and backend rules. Dates remain calendar dates; reminder
 * pauses are exact UTC instants so they do not depend on a server timezone. */
export type DueDateKind = 'estimated' | 'committed' | null;
export type DeadlineState = { dueDate: string | null; kind: DueDateKind; version: number };
export class TaskPlanningError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export function calendarDate(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)
    throw new TaskPlanningError('planning_invalid_date');
  return value;
}
export function dueDateKind(value: unknown): DueDateKind {
  if (value === null) return null;
  if (value === 'estimated' || value === 'committed') return value;
  throw new TaskPlanningError('planning_invalid_kind');
}
export function postponed(before: string | null | undefined, after: string | null | undefined): boolean {
  return !!before && (!after || after > before);
}
export function deadlineReasonRequired(before: Pick<DeadlineState, 'dueDate' | 'kind'>, after: string | null): boolean {
  return before.kind === 'committed' && postponed(before.dueDate, after);
}
export function deadlineChange(before: DeadlineState, date: unknown, kind: unknown, reason: unknown) {
  const nextDate = calendarDate(date), nextKind = dueDateKind(kind);
  if (nextDate === null && nextKind !== null) throw new TaskPlanningError('planning_date_required');
  if (reason !== null && reason !== undefined && typeof reason !== 'string') throw new TaskPlanningError('planning_invalid_reason');
  const why = typeof reason === 'string' ? reason.trim() || null : null;
  if (why && ([...why].length > 2000 || why.includes('\0'))) throw new TaskPlanningError('planning_invalid_reason');
  if (deadlineReasonRequired(before, nextDate) && !why) throw new TaskPlanningError('planning_reason_required');
  return { dueDate: nextDate, kind: nextKind, reason: why };
}
export function reminderPaused(until: unknown, now = new Date()): boolean {
  return typeof until === 'string' && Number.isFinite(Date.parse(until)) && Date.parse(until) > now.getTime();
}
export function reminderUntil(value: unknown, now = new Date()): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value
    || Date.parse(value) <= now.getTime() || Date.parse(value) > now.getTime() + 366 * 86400000)
    throw new TaskPlanningError('planning_invalid_pause');
  return value;
}
/** Inclusive selected local day -> exclusive next local day's start. Binary
 * search over local calendar dates also handles DST and non-hour offsets. */
export function pauseThroughDay(value: string, timeZone: string): string {
  const day = calendarDate(value);
  if (!day) throw new TaskPlanningError('planning_invalid_date');
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { throw new TaskPlanningError('planning_invalid_timezone'); }
  const localDate = (instant: number) => {
    const p = Object.fromEntries(format.formatToParts(new Date(instant)).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  const next = new Date(`${day}T00:00:00.000Z`).getTime() + 86400000;
  const target = new Date(next).toISOString().slice(0, 10);
  let low = next - 16 * 3600000, high = next + 16 * 3600000;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (localDate(mid) < target) low = mid + 1; else high = mid; }
  return new Date(low).toISOString();
}
