import type { Project, ProductLine } from '@/types';

export interface ProjectGroup {
  /** The product line, or null for projects whose line no longer exists. */
  line: ProductLine | null;
  projects: Project[];
}

/**
 * Projects grouped under their product line, in product-line order, for a
 * project <select> with one <optgroup> per line. Archived projects are left
 * out unless listed in keepIds (a task's current project must stay visible, or
 * the select would silently show another one). Projects whose line is missing
 * go into a trailing group instead of disappearing.
 */
export function groupProjectsByLine(
  lines: ProductLine[],
  projects: Project[],
  keepIds: readonly string[] = [],
): ProjectGroup[] {
  const visible = projects.filter(p => !p.isArchived || keepIds.includes(p.id));
  const known = new Set(lines.map(l => l.id));
  const groups: ProjectGroup[] = lines.map(line => ({ line, projects: visible.filter(p => p.lineId === line.id) }));
  groups.push({ line: null, projects: visible.filter(p => !known.has(p.lineId)) });
  return groups.filter(g => g.projects.length > 0);
}

/** <optgroup> label: the line's icon and name, or otherLabel for the trailing group. */
export function projectGroupLabel(line: ProductLine | null, otherLabel: string): string {
  return line ? [line.icon, line.name].filter(Boolean).join(' ') : otherLabel;
}
