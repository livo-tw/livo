/** Display colours only. Never copy these values back into Project.color. */
export interface ProjectColorInput { id: string; color?: string | null }
export type ProjectColorResolver = (project?: ProjectColorInput | string | null) => string;
export const LEGACY_PROJECT_COLOR = '#6B778C';
export const PROJECT_COLOR_PALETTE = [
  '#0065FF', '#36B37E', '#FF5630', '#6554C0', '#00B8D9', '#FF8B00', '#E774BB', '#00875A',
  '#0747A6', '#C25100', '#8777D9', '#D12D75', '#008DA6', '#5243AA', '#AF2D2D', '#6B8E23',
] as const;

function normalizedColor(value?: string | null): string | undefined {
  const color = value?.trim();
  if (color && /^#[\da-f]{6}$/i.test(color)) return color.toUpperCase();
  if (color && /^#[\da-f]{3}$/i.test(color)) return '#' + [...color.slice(1)].map(part => part + part).join('').toUpperCase();
}

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return (result ^ (result >>> 16)) >>> 0;
}

function extendedColor(seed: string): string {
  const value = hash(seed), hue = value % 360, saturation = 0.58 + ((value >>> 9) % 12) / 100, lightness = 0.4 + ((value >>> 17) % 8) / 100;
  const channel = (offset: number) => {
    const k = (offset + hue / 30) % 12, a = saturation * Math.min(lightness, 1 - lightness);
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase();
}

function unusedColor(id: string, occupied: Set<string>): string {
  const first = hash(id) % PROJECT_COLOR_PALETTE.length;
  for (let offset = 0; offset < PROJECT_COLOR_PALETTE.length; offset++) {
    const color = PROJECT_COLOR_PALETTE[(first + offset) % PROJECT_COLOR_PALETTE.length];
    if (!occupied.has(color)) return color;
  }
  let attempt = 0, color: string;
  do { color = extendedColor(`${id}:${attempt++}`); } while (occupied.has(color));
  return color;
}

/**
 * Allocate once against the complete workspace catalog, before view filtering.
 * IDs (not names, sort order or archive status) determine collision resolution.
 * A unique legacy grey is preserved. Repeated legacy greys have no provenance,
 * so they are treated as old defaults; all other stored colours are preserved.
 */
export function createProjectColorResolver(projects: readonly ProjectColorInput[]): ProjectColorResolver {
  const colors = new Map<string, string>();
  const greyCount = projects.filter(project => normalizedColor(project.color) === LEGACY_PROJECT_COLOR).length;
  const automatic: ProjectColorInput[] = [], occupied = new Set<string>();
  for (const project of projects) {
    const color = normalizedColor(project.color);
    if (color && (color !== LEGACY_PROJECT_COLOR || greyCount <= 1)) {
      colors.set(project.id, color); occupied.add(color);
    } else automatic.push(project);
  }
  automatic.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  for (const project of automatic) {
    const color = unusedColor(project.id, occupied);
    colors.set(project.id, color); occupied.add(color);
  }
  return project => {
    if (!project) return LEGACY_PROJECT_COLOR;
    const id = typeof project === 'string' ? project : project.id;
    return colors.get(id) ?? (typeof project === 'object' ? normalizedColor(project.color) : undefined) ?? unusedColor(id, new Set());
  };
}

/** New projects suggest a least-used colour across active and historic projects. */
export function suggestProjectColor(projects: readonly ProjectColorInput[]): string {
  const resolve = createProjectColorResolver(projects), counts = new Map<string, number>();
  for (const project of projects) {
    const color = resolve(project); counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  return PROJECT_COLOR_PALETTE.reduce((best, color) => (counts.get(color) ?? 0) < (counts.get(best) ?? 0) ? color : best);
}
