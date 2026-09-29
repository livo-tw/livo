import { createContext, useContext } from 'react';
import type { Project, ProductLine } from '@/types';

export interface ProjectContextType {
  allProjects: Project[];
  setAllProjects: (p: Project[]) => void;
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string | null) => void;
  selectedLineId: string | null;
  setSelectedLineId: (id: string | null) => void;
  productLines: ProductLine[];
  refreshProductLines: () => Promise<void>;
  createProjectInDb: (project: Project) => Promise<void>;
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
