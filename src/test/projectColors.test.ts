import { describe, expect, it } from 'vitest';
import { createProjectColorResolver, LEGACY_PROJECT_COLOR, PROJECT_COLOR_PALETTE, suggestProjectColor } from '@/lib/projectColors';

describe('workspace project display colours', () => {
  it('preserves explicit colours even when shared and preserves a unique legacy grey', () => {
    const projects = [{ id: 'a', color: '#ff5630' }, { id: 'b', color: '#FF5630' }, { id: 'c', color: '#6b778c' }];
    const resolve = createProjectColorResolver(projects);
    expect(projects.map(resolve)).toEqual(['#FF5630', '#FF5630', LEGACY_PROJECT_COLOR]);
  });

  it('allocates distinct colours for repeated default greys and missing colours, avoiding stored colours', () => {
    const projects = [{ id: 'explicit', color: PROJECT_COLOR_PALETTE[0] }, ...Array.from({ length: 12 }, (_, n) => ({ id: `historical-${n}`, color: n < 10 ? LEGACY_PROJECT_COLOR : '' }))];
    const resolve = createProjectColorResolver(projects), colors = projects.map(resolve);
    expect(new Set(colors).size).toBe(projects.length);
    expect(colors).not.toContain(LEGACY_PROJECT_COLOR);
    expect(resolve('explicit')).toBe(PROJECT_COLOR_PALETTE[0]);
  });

  it('uses stable ID ordering regardless of input order, project name or archive state', () => {
    const projects = Array.from({ length: 20 }, (_, n) => ({ id: `p-${n}`, color: LEGACY_PROJECT_COLOR, name: `Name ${n}`, isArchived: false }));
    const first = createProjectColorResolver(projects);
    const changed = createProjectColorResolver([...projects].reverse().map(project => ({ ...project, name: 'renamed', isArchived: true })));
    for (const project of projects) expect(changed(project)).toBe(first(project.id));
  });

  it('extends the palette without exact colour collisions or invalid alpha suffixes', () => {
    const projects = Array.from({ length: 80 }, (_, n) => ({ id: `many-${n}`, color: '' }));
    const resolve = createProjectColorResolver(projects), colors = projects.map(resolve);
    expect(new Set(colors).size).toBe(80);
    for (const color of colors) expect(color).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('does not change raw project data and resolves a selected project through the complete catalog', () => {
    const projects = Object.freeze([Object.freeze({ id: 'a', color: LEGACY_PROJECT_COLOR }), Object.freeze({ id: 'b', color: LEGACY_PROJECT_COLOR })]);
    const resolve = createProjectColorResolver(projects);
    const selected = projects.filter(project => project.id === 'b');
    expect(resolve(selected[0])).toBe(resolve('b'));
    expect(projects.map(project => project.color)).toEqual([LEGACY_PROJECT_COLOR, LEGACY_PROJECT_COLOR]);
  });

  it('normalizes short hex and replaces unusable or absent stored values', () => {
    const projects = [{ id: 'short', color: '#aBc' }, { id: 'bad', color: 'not-a-color' }, { id: 'missing', color: null }];
    const resolve = createProjectColorResolver(projects);
    expect(resolve('short')).toBe('#AABBCC');
    expect(resolve('bad')).toMatch(/^#[0-9A-F]{6}$/);
    expect(resolve('missing')).not.toBe(resolve('bad'));
    expect(resolve(undefined)).toBe(LEGACY_PROJECT_COLOR);
  });

  it('suggests an unused colour, then a least-used colour when the palette is occupied', () => {
    const projects = PROJECT_COLOR_PALETTE.slice(0, 4).map((color, n) => ({ id: `p-${n}`, color }));
    expect(suggestProjectColor(projects)).toBe(PROJECT_COLOR_PALETTE[4]);
    const full = PROJECT_COLOR_PALETTE.map((color, n) => ({ id: `p-${n}`, color }));
    expect(suggestProjectColor([...full, { id: 'extra', color: PROJECT_COLOR_PALETTE[0] }])).toBe(PROJECT_COLOR_PALETTE[1]);
  });

  it('new suggestions account for automatic historic colours without recolouring them', () => {
    const projects = Array.from({ length: 8 }, (_, n) => ({ id: `legacy-${n}`, color: LEGACY_PROJECT_COLOR }));
    const before = createProjectColorResolver(projects), suggested = suggestProjectColor(projects);
    expect(projects.map(before)).not.toContain(suggested);
    const after = createProjectColorResolver([...projects, { id: 'new-project', color: suggested }]);
    for (const project of projects) expect(after(project)).toBe(before(project));
  });
});
