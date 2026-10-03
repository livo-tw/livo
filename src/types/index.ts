export interface User {
  id: string;
  name: string;
  avatar: string;
  role: 'super_admin' | 'admin' | 'member';
  qaAdmin?: boolean;
  jobTitle: string;
  color: string;
  email: string;
  isActive: boolean;
  sortOrder: number;
}

export interface ProductLine {
  id: string;
  name: string;
  icon: string;
  color: string;
  sortOrder: number;
}

export interface Project {
  id: string;
  lineId: string;
  name: string;
  key: string;
  color: string;
  isArchived: boolean;
}

export interface Status {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  isDone: boolean;
  autoStart: boolean;
  autoDone: boolean;
}

export type Priority = 'highest' | 'high' | 'medium' | 'low' | 'lowest';

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface Task {
  id: string;
  taskKey: string;
  projectId: string;
  title: string;
  statusId: string;
  priority: Priority;
  creatorId: string;
  assigneeId?: string;
  reviewerId?: string;
  assigneeRevision?: number;
  reviewerRevision?: number;
  assigneeAcknowledgedAt?: string;
  reviewerAcknowledgedAt?: string;
  dueDate?: string;
  dueDateKind?: 'estimated' | 'committed' | null;
  dueDateVersion?: number;
  dueDateChangeReason?: string | null;
  startedAt?: string;
  completedAt?: string;
  gitlabUrl?: string;
  sortOrder: number;
  createdAt: string;
  commentCount: number;
  attachmentCount: number;
  deployments: TaskDeployment[];
  sprintId?: string;
  department?: string;
  tagIds?: string[];
  parentTaskId?: string;
  approvalStatus?: string | null;
  currentApprovalId?: string | null;
  requiresApproval?: boolean;
}

export interface TaskSpec {
  id: string;
  taskId: string;
  background: string;
  requirement: string;
  notes: string;
}

export interface TaskCheck {
  id: string;
  taskId: string;
  text: string;
  isDone: boolean;
  sortOrder: number;
  version?: number;
}

export interface TaskTodo {
  id: string;
  taskId: string;
  text: string;
  isDone: boolean;
  sortOrder: number;
  version?: number;
}

export interface TaskDeployment {
  environment: string;
  status: 'deployed' | 'scheduled';
  deployDate?: string;
}

export interface Comment {
  id: string;
  taskId: string;
  userId: string;
  content: string;
  createdAt: string;
  attachmentUrl?: string;
  attachmentName?: string;
  attachmentSize?: number;
}

export interface StatusLog {
  id: string;
  taskId: string;
  fromStatusId?: string;
  toStatusId: string;
  changedBy: string;
  changedAt: string;
}

export type CustomFieldType = import('../lib/customFieldTypes').CustomFieldType;

export interface CustomField {
  id: string;
  projectId: string;
  fieldName: string;
  fieldType: CustomFieldType;
  options?: string[];       // 下拉選單用
  isRequired: boolean;
  defaultValue?: string;
  sortOrder: number;
  createdAt: string;
}

export interface TaskCustomFieldValue {
  id: string;
  taskId: string;
  fieldId: string;
  valueText?: string;
  valueNumber?: number;
  valueDate?: string;
  valueBoolean?: boolean;
  valueUserId?: string;
}

export interface TaskDependency {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  dependencyType: 'finish_to_start';
  createdAt: string;
}

export interface TaskTemplate {
  id: string;
  projectId: string | null;
  name: string;
  description: string;
  defaultPriority: Priority | null;
  defaultTagIds: string[];
  defaultSpecBackground: string;
  defaultSpecRequirement: string;
  defaultSpecNotes: string;
  defaultCheckItems: string[];
  defaultTodoItems: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
