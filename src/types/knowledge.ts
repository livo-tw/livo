/** Shared wire models for both knowledge-base backends. */
export type KnowledgePage = {
  id: string;
  title: string;
  body: string;
  project_id: string | null;
  parent_id: string | null;
  sort_order: number;
  is_archived: boolean;
  admin_only: boolean;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export type KnowledgeRevision = {
  id: string;
  page_id: string;
  body: string;
  created_by: string;
  created_at: string;
  version: number;
}

export type KnowledgeAttachment = {
  id: string;
  page_id: string;
  file_name: string;
  file_size: number;
  file_type: string;
  storage_path: string;
  uploaded_by: string;
  created_at: string;
}

type Table<Row, Insert> = { Row: Row; Insert: Insert; Update: Partial<Row>; Relationships: [] };
export type KnowledgeTables = {
  field_locks: Table<{ lock_key: string; locked_by: string; expires_at: string }, never>;
  kb_pages: Table<KnowledgePage, Pick<KnowledgePage, 'title' | 'created_by' | 'updated_by'> & Partial<KnowledgePage>>;
  kb_revisions: Table<KnowledgeRevision, KnowledgeRevision>;
  kb_attachments: Table<KnowledgeAttachment, Omit<KnowledgeAttachment, 'id' | 'created_at'> & Partial<KnowledgeAttachment>>;
};

export type FieldLockFunctions = {
  acquire_field_lock: { Args: { p_lock_key: string; p_member_id: string; p_ttl_seconds?: number }; Returns: { acquired: boolean; locked_by?: string } };
  release_field_lock: { Args: { p_lock_key: string; p_member_id: string }; Returns: undefined };
  release_all_locks: { Args: { p_member_id: string }; Returns: undefined };
};
