import { createContext, useContext } from 'react';
import type { Project, ProductLine } from '@/types';
import type { ProjectColorResolver } from '@/lib/projectColors';

export interface ProjectContextType {
  allProjects: Project[];
  /** Presentation only; allProjects and mutations retain the stored colour. */
  getProjectColor?: ProjectColorResolver;
  setAllProjects: (p: Project[]) => void;
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string | null) => void;
  selectedLineId: string | null;
  setSelectedLineId: (id: string | null) => void;
  productLines: ProductLine[];
  refreshProductLines: () => Promise<void>;
  /** Resolves to the error message on failure, null on success. */
  createProjectInDb: (project: Project) => Promise<string | null>;
  updateProjectInDb: (projectId: string, updates: Partial<Project>) => Promise<void>;
  deleteProjectInDb: (projectId: string) => Promise<void>;
  createProductLineInDb: (line: ProductLine) => Promise<void>;
  updateProductLineInDb: (lineId: string, updates: Partial<ProductLine>) => Promise<void>;
  deleteProductLineInDb: (lineId: string) => Promise<boolean>;
}

export const ProjectContext = createContext<ProjectContextType | null>(null);

export const useProjectContext = () => {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProjectContext must be used within AppProvider');
  return ctx;
};
