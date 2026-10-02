import { describe, expect, it } from 'vitest';
import { groupProjectsByLine, projectGroupLabel, slackProjectOptionGroups } from '@/lib/projectGroups';
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

  it('preserves a history filter subset and includes archived rows only when requested', () => {
    const subset = [projects[2], projects[4]];
    expect(groupProjectsByLine(lines, subset, { archived: 'all' }).flatMap(group => group.projects.map(project => project.id))).toEqual(['p3', 'p5']);
    expect(groupProjectsByLine(lines, subset).flatMap(group => group.projects.map(project => project.id))).toEqual(['p5']);
    expect(groupProjectsByLine(lines, subset, { keepIds: ['p3', 'not-authorized'] }).flatMap(group => group.projects.map(project => project.id))).toEqual(['p3', 'p5']);
  });

  it('keeps legacy known-line-only picker sets without changing source order or input arrays', () => {
    const before = JSON.stringify({ lines, projects });
    const result = groupProjectsByLine(lines, projects, { includeUnclassified: false });
    expect(result.flatMap(group => group.projects.map(project => project.id))).toEqual(['p2', 'p1', 'p5']);
    expect(JSON.stringify({ lines, projects })).toBe(before);
  });

  it('renders identical grouped IDs for Slack including same names and missing-line fallback', () => {
    const sameNames = projects.map(project => ({ ...project, name: 'Same name' }));
    const groups = groupProjectsByLine(lines, sameNames);
    expect(slackProjectOptionGroups(groups, 'Other').map(group => [group.label.text, group.options.map(option => option.value)])).toEqual([
      ['🎮 Games', ['p2']], ['Platform', ['p1', 'p5']], ['Other', ['p4']],
    ]);
  });
});

describe('projectGroupLabel', () => {
  it('joins icon and name, skips an empty icon and uses the fallback for the trailing group', () => {
    expect(projectGroupLabel(lines[0], 'Other')).toBe('🎮 Games');
    expect(projectGroupLabel(lines[1], 'Other')).toBe('Platform');
    expect(projectGroupLabel(null, 'Other')).toBe('Other');
  });
});
