import { describe, expect, it } from 'vitest';
import { groupProjectsByLine, projectGroupLabel } from '@/lib/projectGroups';
import type { ProductLine, Project } from '@/types';

const line = (id: string, name: string, icon = ''): ProductLine => ({ id, name, icon, color: '#6B778C', sortOrder: 0 });
const project = (id: string, lineId: string, isArchived = false): Project =>
  ({ id, lineId, name: `Project ${id}`, key: id.toUpperCase(), color: '#6B778C', isArchived });

const lines = [line('l1', 'Games', '🎮'), line('l2', 'Platform'), line('l3', 'Empty line')];
const projects = [
  project('p1', 'l2'), project('p2', 'l1'), project('p3', 'l1', true),
  project('p4', 'gone'), project('p5', 'l2'),
];

describe('groupProjectsByLine', () => {
  it('groups by line in line order and drops archived projects and empty lines', () => {
    expect(groupProjectsByLine(lines, projects).map(g => [g.line?.id ?? null, g.projects.map(p => p.id)])).toEqual([
      ['l1', ['p2']],
      ['l2', ['p1', 'p5']],
      [null, ['p4']],
    ]);
  });

  it('keeps an archived project that is listed in keepIds', () => {
    expect(groupProjectsByLine(lines, projects, ['p3'])[0].projects.map(p => p.id)).toEqual(['p2', 'p3']);
  });

  it('puts projects of a missing line in a trailing group instead of hiding them', () => {
    const groups = groupProjectsByLine([], projects);
    expect(groups).toHaveLength(1);
    expect(groups[0].line).toBeNull();
    expect(groups[0].projects.map(p => p.id)).toEqual(['p1', 'p2', 'p4', 'p5']);
  });
});

describe('projectGroupLabel', () => {
  it('joins icon and name, skips an empty icon and uses the fallback for the trailing group', () => {
    expect(projectGroupLabel(lines[0], 'Other')).toBe('🎮 Games');
    expect(projectGroupLabel(lines[1], 'Other')).toBe('Platform');
    expect(projectGroupLabel(null, 'Other')).toBe('Other');
  });
});
