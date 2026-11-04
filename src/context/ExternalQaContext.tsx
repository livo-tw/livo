import { createContext, useContext } from 'react';
import type { Task } from '@/types';

export const NO_QA_TASKS: Task[] = [];

export const ExternalQaContext = createContext(false);
export const useExternalQa = () => useContext(ExternalQaContext);
