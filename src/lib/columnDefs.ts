/**
 * columnDefs.ts — Column definitions for list views.
 *
 * Derived from fieldRegistry so there is a single source of truth.
 * Views import from here (for ColumnDef type compatibility with useColumnConfig).
 */
import type { ColumnDef } from '@/hooks/useColumnConfig';
import { LIST_FIXED_FIELDS, LIST_OPTIONAL_FIELDS, DEFAULT_VISIBLE_KEYS } from '@/lib/fieldRegistry';

/** Fixed columns that always appear first (編號, 卡片名稱) */
export const FIXED_COLUMNS: ColumnDef[] = LIST_FIXED_FIELDS.map(f => ({
  key: f.key,
  label: f.label,
  width: f.listWidth,
  fixed: true,
}));

/** All optional columns the user can toggle */
export const OPTIONAL_COLUMNS: ColumnDef[] = LIST_OPTIONAL_FIELDS.map(f => ({
  key: f.key,
  label: f.label,
  width: f.listWidth,
}));

export const FIXED_KEYS = FIXED_COLUMNS.map(c => c.key);

/** Default visible optional column keys (shared across all list views) */
export const DEFAULT_VISIBLE_COMMON = DEFAULT_VISIBLE_KEYS;
export const DEFAULT_VISIBLE_LISTVIEW = DEFAULT_VISIBLE_KEYS;
export const DEFAULT_VISIBLE_ALLLIST = DEFAULT_VISIBLE_KEYS;
export const DEFAULT_VISIBLE_MYTASKS = DEFAULT_VISIBLE_KEYS;
