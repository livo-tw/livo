import { useMemo } from 'react';
import { useProjectContext } from '@/context/ProjectContext';
import { createProjectColorResolver, type ProjectColorInput } from '@/lib/projectColors';

const EMPTY_PROJECTS: readonly ProjectColorInput[] = [];

/** Full-catalog resolver shared by task, QA, navigation and project pickers. */
export function useProjectColor() {
  const { allProjects, getProjectColor } = useProjectContext();
  return useMemo(() => getProjectColor ?? createProjectColorResolver(allProjects ?? EMPTY_PROJECTS), [getProjectColor, allProjects]);
}
