/** Structural types keep this module usable by React, Workers and Deno. */
export interface ProjectOption {
  id: string;
  name: string;
  lineId?: string | null;
  isArchived?: boolean;
  color?: string;
}
export interface ProductLineOption { id: string; name: string; icon?: string }

export interface ProjectGroup<P extends ProjectOption = ProjectOption, L extends ProductLineOption = ProductLineOption> {
  /** The product line, or null for projects whose line no longer exists. */
  line: L | null;
  projects: P[];
}

export interface ProjectGroupOptions {
  /** Read/history filters may include archived projects; creation defaults to active. */
  archived?: 'active' | 'all';
  keepIds?: readonly string[];
  /** Preserve legacy pickers that accept only projects in an existing line. */
  includeUnclassified?: boolean;
}

/**
 * Projects grouped under their product line, in product-line order, for a
 * project <select> with one <optgroup> per line. Archived projects are left
 * out unless listed in keepIds (a task's current project must stay visible, or
 * the select would silently show another one). Projects whose line is missing
 * go into a trailing group instead of disappearing.
 */
export function groupProjectsByLine<P extends ProjectOption, L extends ProductLineOption>(
  lines: readonly L[],
  projects: readonly P[],
  options: ProjectGroupOptions | readonly string[] = {},
): ProjectGroup<P, L>[] {
  const config: ProjectGroupOptions = Array.isArray(options) ? { keepIds: options } : options as ProjectGroupOptions;
  const keep = new Set(config.keepIds ?? []);
  const visible = projects.filter(p => config.archived === 'all' || !p.isArchived || keep.has(p.id));
  const known = new Set(lines.map(l => l.id));
  const groups: ProjectGroup<P, L>[] = lines.map(line => ({ line, projects: visible.filter(p => p.lineId === line.id) }));
  if (config.includeUnclassified !== false) groups.push({ line: null, projects: visible.filter(p => !p.lineId || !known.has(p.lineId)) });
  return groups.filter(g => g.projects.length > 0);
}

/** <optgroup> label: the line's icon and name, or otherLabel for the trailing group. */
export function projectGroupLabel(line: ProductLineOption | null, otherLabel: string): string {
  return line ? [line.icon, line.name].filter(Boolean).join(' ') : otherLabel;
}

/** Slack's rendering adapter shares the same grouping and accepts authorized rows only. */
export function slackProjectOptionGroups(groups: readonly ProjectGroup[], otherLabel: string) {
  return groups.slice(0, 100).map(group => ({
    label: { type: 'plain_text' as const, text: projectGroupLabel(group.line, otherLabel).slice(0, 75) },
    options: group.projects.slice(0, 100).map(project => ({
      text: { type: 'plain_text' as const, text: project.name.slice(0, 75) || project.id },
      value: project.id,
    })),
  }));
}
