/**
 * fieldRegistry.ts — Single source of truth for all task field metadata.
 *
 * Defines every built-in field's label, which views it appears in,
 * whether it can be required, its list column width, its kanban card key, etc.
 *
 * Custom fields (from the database) are NOT listed here — they are merged in
 * dynamically by useListColumns / hooks that consume this registry.
 */

import i18n from '@/i18n';

export type FieldView = 'list' | 'kanban' | 'gantt' | 'detail' | 'create';

export interface BuiltinFieldDef {
  /** Unique field key (matches Task property or column key) */
  key: string;
  /** i18n key for the display label */
  labelKey: string;
  /** Which views this field participates in */
  views: FieldView[];
  /** Width for list-view column. Omit for fixed/title columns. */
  listWidth?: string;
  /** If true, always visible (fixed) in list views — cannot be toggled off */
  listFixed?: boolean;
  /** Can be used as a filter in list/board views */
  filterable?: boolean;
  /** Can be sorted by in list views */
  sortable?: boolean;
  /** Can be toggled as "required" in admin RequiredFieldsSettings */
  canBeRequired?: boolean;
  /** License feature gate key ('subtasks' | 'task-dependencies') */
  featureGate?: string;
  /** Whether this optional column is visible by default in list views */
  defaultVisible?: boolean;
  /** Key in RequiredFieldsConfig (if different from .key, e.g. startedAt → startDate) */
  requiredKey?: string;
  /** i18n key for group label shown in RequiredFieldsSettings UI */
  requiredGroupKey?: string;
  /** Corresponding key in CardFieldVisibility (for kanban card display) */
  cardKey?: string;
  /** i18n key for label override shown in kanban card settings (defaults to .labelKey) */
  cardLabelKey?: string;

  /** Computed display label (Traditional Chinese / English / etc.) */
  get label(): string;
  /** Computed required group label */
  get requiredGroup(): string | undefined;
  /** Computed card label */
  get cardLabel(): string | undefined;
}

// Helper to create a field def with getter properties
function field(def: {
  key: string;
  labelKey: string;
  views: FieldView[];
  listWidth?: string;
  listFixed?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  canBeRequired?: boolean;
  featureGate?: string;
  defaultVisible?: boolean;
  requiredKey?: string;
  requiredGroupKey?: string;
  cardKey?: string;
  cardLabelKey?: string;
}): BuiltinFieldDef {
  return {
    ...def,
    get label() { return i18n.t(def.labelKey); },
    get requiredGroup() { return def.requiredGroupKey ? i18n.t(def.requiredGroupKey) : undefined; },
    get cardLabel() { return def.cardLabelKey ? i18n.t(def.cardLabelKey) : undefined; },
  };
}

// ─────────────────────────────────────────────────────────────
//  CardFieldVisibility — controls extra fields on kanban cards
// ─────────────────────────────────────────────────────────────

export interface CardFieldVisibility {
  taskKey: boolean;
  commentCount: boolean;
  attachmentCount: boolean;
  gitlabUrl: boolean;
  department: boolean;
  tags: boolean;
  deployments: boolean;
  subtaskCount: boolean;
  status: boolean;
  reviewer: boolean;
  dependencyCount: boolean;
}

export const DEFAULT_CARD_FIELDS: CardFieldVisibility = {
  taskKey: true,
  commentCount: true,
  attachmentCount: true,
  gitlabUrl: true,
  department: true,
  tags: true,
  deployments: true,
  subtaskCount: true,
  status: false,
  reviewer: false,
  dependencyCount: true,
};

// ─────────────────────────────────────────────────────────────
//  Master field list — ordered as they appear in list columns
// ─────────────────────────────────────────────────────────────

export const BUILTIN_FIELDS: BuiltinFieldDef[] = [
  // ── Fixed list columns (always visible, non-toggleable) ────
  field({
    key: 'taskKey',
    labelKey: 'fieldRegistry.taskKey',
    views: ['list', 'kanban'],
    listWidth: '90px',
    listFixed: true,
    sortable: true,
    cardKey: 'taskKey',
    cardLabelKey: 'fieldRegistry.cardTaskKey',
  }),
  field({
    key: 'title',
    labelKey: 'fieldRegistry.title',
    views: ['list', 'kanban', 'detail', 'create'],
    listFixed: true,
    sortable: true,
    canBeRequired: true,
    requiredKey: 'title',
    requiredGroupKey: 'fieldRegistry.group.basicInfo',
  }),

  // ── Optional list columns ───────────────────────────────────
  field({
    key: 'project',
    labelKey: 'fieldRegistry.project',
    views: ['list'],
    listWidth: '130px',
    filterable: true,
    sortable: true,
    canBeRequired: true,
    requiredKey: 'project',
    requiredGroupKey: 'fieldRegistry.group.basicInfo',
    defaultVisible: true,
  }),
  field({
    key: 'status',
    labelKey: 'fieldRegistry.status',
    views: ['list', 'kanban'],
    listWidth: '100px',
    filterable: true,
    sortable: true,
    canBeRequired: true,
    requiredKey: 'status',
    requiredGroupKey: 'fieldRegistry.group.basicInfo',
    defaultVisible: true,
    cardKey: 'status',
    cardLabelKey: 'fieldRegistry.cardStatus',
  }),
  field({
    key: 'priority',
    labelKey: 'fieldRegistry.priority',
    views: ['list', 'kanban'],
    listWidth: '70px',
    filterable: true,
    sortable: true,
    canBeRequired: true,
    requiredKey: 'priority',
    requiredGroupKey: 'fieldRegistry.group.basicInfo',
    defaultVisible: true,
  }),
  field({
    key: 'createdAt',
    labelKey: 'fieldRegistry.createdAt',
    views: ['list'],
    listWidth: '85px',
    sortable: true,
  }),
  field({
    key: 'startedAt',
    labelKey: 'fieldRegistry.startedAt',
    views: ['list'],
    listWidth: '85px',
    sortable: true,
    canBeRequired: true,
    requiredKey: 'startDate',
    requiredGroupKey: 'fieldRegistry.group.dates',
  }),
  field({
    key: 'dueDate',
    labelKey: 'fieldRegistry.dueDate',
    views: ['list'],
    listWidth: '85px',
    sortable: true,
    canBeRequired: true,
    requiredKey: 'dueDate',
    requiredGroupKey: 'fieldRegistry.group.dates',
    defaultVisible: true,
  }),
  field({
    key: 'sprint',
    labelKey: 'fieldRegistry.sprint',
    views: ['list'],
    listWidth: '100px',
    sortable: true,
  }),
  field({
    key: 'department',
    labelKey: 'fieldRegistry.department',
    views: ['list', 'kanban'],
    listWidth: '85px',
    filterable: true,
    sortable: true,
    cardKey: 'department',
    cardLabelKey: 'fieldRegistry.cardDepartment',
  }),
  field({
    key: 'assignee',
    labelKey: 'fieldRegistry.assignee',
    views: ['list', 'kanban'],
    listWidth: '110px',
    filterable: true,
    sortable: true,
    canBeRequired: true,
    requiredKey: 'assignee',
    requiredGroupKey: 'fieldRegistry.group.basicInfo',
    defaultVisible: true,
  }),
  field({
    key: 'reviewer',
    labelKey: 'fieldRegistry.reviewer',
    views: ['list', 'kanban'],
    listWidth: '110px',
    filterable: true,
    sortable: true,
    canBeRequired: true,
    requiredKey: 'reviewer',
    requiredGroupKey: 'fieldRegistry.group.basicInfo',
    defaultVisible: true,
    cardKey: 'reviewer',
  }),
  field({
    key: 'tags',
    labelKey: 'fieldRegistry.tags',
    views: ['list', 'kanban'],
    listWidth: '140px',
    filterable: true,
    canBeRequired: true,
    requiredKey: 'tags',
    requiredGroupKey: 'fieldRegistry.group.category',
    cardKey: 'tags',
    cardLabelKey: 'fieldRegistry.cardTags',
  }),
  field({
    key: 'deployments',
    labelKey: 'fieldRegistry.deployments',
    views: ['list', 'kanban'],
    listWidth: '160px',
    canBeRequired: true,
    requiredKey: 'deployments',
    requiredGroupKey: 'fieldRegistry.group.other',
    cardKey: 'deployments',
    cardLabelKey: 'fieldRegistry.cardDeployments',
  }),
  field({
    key: 'gitlabUrl',
    labelKey: 'fieldRegistry.gitlabUrl',
    views: ['list', 'kanban'],
    listWidth: '80px',
    canBeRequired: true,
    requiredKey: 'gitlabUrl',
    requiredGroupKey: 'fieldRegistry.group.other',
    cardKey: 'gitlabUrl',
    cardLabelKey: 'fieldRegistry.cardGitlab',
  }),
  field({
    key: 'subtasks',
    labelKey: 'fieldRegistry.subtasks',
    views: ['list', 'kanban'],
    listWidth: '90px',
    featureGate: 'subtasks',
    cardKey: 'subtaskCount',
    cardLabelKey: 'fieldRegistry.cardSubtasks',
  }),
  field({
    key: 'dependencies',
    labelKey: 'fieldRegistry.dependencies',
    views: ['list', 'kanban'],
    listWidth: '80px',
    featureGate: 'task-dependencies',
    cardKey: 'dependencyCount',
    cardLabelKey: 'fieldRegistry.cardDependencies',
  }),

  // ── Detail / create-only fields (never list columns) ────────
  field({
    key: 'background',
    labelKey: 'fieldRegistry.background',
    views: ['detail', 'create'],
    canBeRequired: true,
    requiredKey: 'background',
    requiredGroupKey: 'fieldRegistry.group.description',
  }),
  field({
    key: 'requirement',
    labelKey: 'fieldRegistry.requirement',
    views: ['detail', 'create'],
    canBeRequired: true,
    requiredKey: 'requirement',
    requiredGroupKey: 'fieldRegistry.group.description',
  }),
  field({
    key: 'notes',
    labelKey: 'fieldRegistry.notes',
    views: ['detail', 'create'],
    canBeRequired: true,
    requiredKey: 'notes',
    requiredGroupKey: 'fieldRegistry.group.description',
  }),
  field({
    key: 'checks',
    labelKey: 'fieldRegistry.checks',
    views: ['detail', 'create'],
    canBeRequired: true,
    requiredKey: 'checks',
    requiredGroupKey: 'fieldRegistry.group.lists',
  }),
  field({
    key: 'todos',
    labelKey: 'fieldRegistry.todos',
    views: ['detail', 'create'],
    canBeRequired: true,
    requiredKey: 'todos',
    requiredGroupKey: 'fieldRegistry.group.lists',
  }),
];

// ─────────────────────────────────────────────────────────────
//  Derived slices — used by columnDefs, BoardView, RequiredFieldsSettings
// ─────────────────────────────────────────────────────────────

/** Fixed list columns (always shown, non-toggleable) */
export const LIST_FIXED_FIELDS = BUILTIN_FIELDS.filter(f => f.listFixed && f.views.includes('list'));

/** Optional list columns (user can toggle on/off) */
export const LIST_OPTIONAL_FIELDS = BUILTIN_FIELDS.filter(f => !f.listFixed && f.views.includes('list'));

/**
 * Options shown in the kanban card field settings panel.
 * Order matches the original BoardView CARD_FIELD_OPTIONS order.
 */
export const KANBAN_CARD_FIELD_OPTIONS: { key: keyof CardFieldVisibility; label: string }[] = (() => {
  // Build a lookup for cardKey → field def
  const byCardKey = new Map(
    BUILTIN_FIELDS.filter(f => f.cardKey).map(f => [f.cardKey!, f])
  );
  // Desired display order (matches original BoardView hardcoded list)
  const ORDER: (keyof CardFieldVisibility)[] = [
    'taskKey', 'status', 'department', 'tags', 'reviewer',
    'subtaskCount', 'dependencyCount', 'commentCount', 'attachmentCount', 'gitlabUrl', 'deployments',
  ];
  return ORDER.map(cardKey => {
    const f = byCardKey.get(cardKey);
    if (f) return { key: cardKey, get label() { return f.cardLabel ?? f.label; } };
    // commentCount / attachmentCount have no column entry — define inline
    if (cardKey === 'commentCount') return { key: cardKey, get label() { return i18n.t('fieldRegistry.commentCount'); } };
    if (cardKey === 'attachmentCount') return { key: cardKey, get label() { return i18n.t('fieldRegistry.attachmentCount'); } };
    return { key: cardKey, get label() { return cardKey; } };
  });
})();

/**
 * Fields eligible for RequiredFieldsSettings, grouped.
 * Returns entries with `requiredKey` (key in RequiredFieldsConfig) and group.
 */
export const REQUIRED_FIELD_DEFS: { key: string; label: string; group: string }[] =
  BUILTIN_FIELDS
    .filter(f => f.canBeRequired && f.requiredKey && f.requiredGroupKey)
    .map(f => ({
      key: f.requiredKey!,
      get label() { return f.label; },
      get group() { return f.requiredGroup!; },
    }));

/** Default visible optional columns in list view */
export const DEFAULT_VISIBLE_KEYS = new Set(
  LIST_OPTIONAL_FIELDS.filter(f => f.defaultVisible).map(f => f.key),
);

/** Filterable field keys */
export const FILTERABLE_FIELD_KEYS = BUILTIN_FIELDS
  .filter(f => f.filterable)
  .map(f => ({ key: f.key, get label() { return f.label; } }));

/** Sortable field keys */
export const SORTABLE_FIELD_KEYS = BUILTIN_FIELDS
  .filter(f => f.sortable)
  .map(f => ({ key: f.key, get label() { return f.label; } }));
