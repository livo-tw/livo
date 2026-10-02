export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      system_settings: {
        Row: { key: string; value: Json; updated_at: string; updated_by: string | null }
        Insert: { key: string; value?: Json; updated_at?: string; updated_by?: string | null }
        Update: { key?: string; value?: Json; updated_at?: string; updated_by?: string | null }
        Relationships: []
      }
      team_settings: {
        Row: { key: string; value: Json; updated_at: string; updated_by: string | null }
        Insert: { key: string; value?: Json; updated_at?: string; updated_by?: string | null }
        Update: { key?: string; value?: Json; updated_at?: string; updated_by?: string | null }
        Relationships: []
      }
      activity_logs: {
        Row: {
          action: string
          created_at: string
          detail: string
          id: string
          target_type: string
          task_id: string | null
          task_key: string | null
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          detail?: string
          id?: string
          target_type?: string
          task_id?: string | null
          task_key?: string | null
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          detail?: string
          id?: string
          target_type?: string
          task_id?: string | null
          task_key?: string | null
          user_id?: string
        }
        Relationships: []
      }
      backup_history: {
        Row: {
          created_at: string
          file_size: number
          filename: string
          id: string
          storage_path: string
        }
        Insert: {
          created_at?: string
          file_size?: number
          filename: string
          id?: string
          storage_path: string
        }
        Update: {
          created_at?: string
          file_size?: number
          filename?: string
          id?: string
          storage_path?: string
        }
        Relationships: []
      }
      backup_settings: {
        Row: {
          backup_hour: number
          dm_notify_enabled: boolean
          dm_notify_end_hour: number
          dm_notify_start_hour: number
          enabled: boolean
          id: string
          interval_days: number
          last_backup_at: string | null
          notify_channel: string
          notify_email: string
          task_notify_channel: string
          task_notify_types: string[]
          updated_at: string
        }
        Insert: {
          backup_hour?: number
          dm_notify_enabled?: boolean
          dm_notify_end_hour?: number
          dm_notify_start_hour?: number
          enabled?: boolean
          id?: string
          interval_days?: number
          last_backup_at?: string | null
          notify_channel?: string
          notify_email?: string
          task_notify_channel?: string
          task_notify_types?: string[]
          updated_at?: string
        }
        Update: {
          backup_hour?: number
          dm_notify_enabled?: boolean
          dm_notify_end_hour?: number
          dm_notify_start_hour?: number
          enabled?: boolean
          id?: string
          interval_days?: number
          last_backup_at?: string | null
          notify_channel?: string
          notify_email?: string
          task_notify_channel?: string
          task_notify_types?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      comments: {
        Row: {
          attachment_name: string | null
          attachment_size: number | null
          attachment_url: string | null
          content: string
          created_at: string
          id: string
          task_id: string
          user_id: string
        }
        Insert: {
          attachment_name?: string | null
          attachment_size?: number | null
          attachment_url?: string | null
          content: string
          created_at?: string
          id: string
          task_id: string
          user_id: string
        }
        Update: {
          attachment_name?: string | null
          attachment_size?: number | null
          attachment_url?: string | null
          content?: string
          created_at?: string
          id?: string
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      member_manuals: {
        Row: {
          best_state: string
          bonus: string
          communication: string
          custom_fields: Json
          difficulty: string
          id: string
          landmine: string
          member_id: string
          updated_at: string
        }
        Insert: {
          best_state?: string
          bonus?: string
          communication?: string
          custom_fields?: Json
          difficulty?: string
          id?: string
          landmine?: string
          member_id: string
          updated_at?: string
        }
        Update: {
          best_state?: string
          bonus?: string
          communication?: string
          custom_fields?: Json
          difficulty?: string
          id?: string
          landmine?: string
          member_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_manuals_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: true
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      members: {
        Row: {
          auth_id: string | null
          avatar: string
          color: string
          email: string
          id: string
          is_active: boolean
          job_title: string
          name: string
          role: Database["public"]["Enums"]["app_member_role"]
          sort_order: number
        }
        Insert: {
          auth_id?: string | null
          avatar: string
          color?: string
          email?: string
          id: string
          is_active?: boolean
          job_title?: string
          name: string
          role?: Database["public"]["Enums"]["app_member_role"]
          sort_order?: number
        }
        Update: {
          auth_id?: string | null
          avatar?: string
          color?: string
          email?: string
          id?: string
          is_active?: boolean
          job_title?: string
          name?: string
          role?: Database["public"]["Enums"]["app_member_role"]
          sort_order?: number
        }
        Relationships: []
      }
      notifications: {
        Row: {
          content: string
          created_at: string
          id: string
          is_read: boolean
          recipient_id: string
          sender_id: string
          task_id: string
          type: string
        }
        Insert: {
          content?: string
          created_at?: string
          id?: string
          is_read?: boolean
          recipient_id: string
          sender_id: string
          task_id: string
          type: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          is_read?: boolean
          recipient_id?: string
          sender_id?: string
          task_id?: string
          type?: string
        }
        Relationships: []
      }
      product_lines: {
        Row: {
          color: string
          icon: string
          id: string
          name: string
          sort_order: number
        }
        Insert: {
          color?: string
          icon?: string
          id: string
          name: string
          sort_order?: number
        }
        Update: {
          color?: string
          icon?: string
          id?: string
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          color: string
          id: string
          is_archived: boolean
          key: string
          line_id: string
          name: string
        }
        Insert: {
          color?: string
          id: string
          is_archived?: boolean
          key: string
          line_id: string
          name: string
        }
        Update: {
          color?: string
          id?: string
          is_archived?: boolean
          key?: string
          line_id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_line_id_fkey"
            columns: ["line_id"]
            isOneToOne: false
            referencedRelation: "product_lines"
            referencedColumns: ["id"]
          },
        ]
      }
      sprints: {
        Row: {
          completed_at: string | null
          completed_count: number
          id: string
          is_active: boolean
          name: string
          pending_count: number
          started_at: string
        }
        Insert: {
          completed_at?: string | null
          completed_count?: number
          id?: string
          is_active?: boolean
          name?: string
          pending_count?: number
          started_at?: string
        }
        Update: {
          completed_at?: string | null
          completed_count?: number
          id?: string
          is_active?: boolean
          name?: string
          pending_count?: number
          started_at?: string
        }
        Relationships: []
      }
      status_logs: {
        Row: {
          changed_at: string
          changed_by: string
          from_status_id: string | null
          id: string
          task_id: string
          to_status_id: string
        }
        Insert: {
          changed_at?: string
          changed_by: string
          from_status_id?: string | null
          id: string
          task_id: string
          to_status_id: string
        }
        Update: {
          changed_at?: string
          changed_by?: string
          from_status_id?: string | null
          id?: string
          task_id?: string
          to_status_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "status_logs_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "status_logs_from_status_id_fkey"
            columns: ["from_status_id"]
            isOneToOne: false
            referencedRelation: "statuses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "status_logs_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "status_logs_to_status_id_fkey"
            columns: ["to_status_id"]
            isOneToOne: false
            referencedRelation: "statuses"
            referencedColumns: ["id"]
          },
        ]
      }
      status_transition_rules: {
        Row: {
          id: string
          target_status_id: string
          required_status_id: string
          created_at: string
        }
        Insert: {
          id?: string
          target_status_id: string
          required_status_id: string
          created_at?: string
        }
        Update: {
          id?: string
          target_status_id?: string
          required_status_id?: string
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "status_transition_rules_target_status_id_fkey"
            columns: ["target_status_id"]
            isOneToOne: false
            referencedRelation: "statuses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "status_transition_rules_required_status_id_fkey"
            columns: ["required_status_id"]
            isOneToOne: false
            referencedRelation: "statuses"
            referencedColumns: ["id"]
          },
        ]
      }
      statuses: {
        Row: {
          auto_done: boolean
          auto_start: boolean
          color: string
          id: string
          is_done: boolean
          name: string
          sort_order: number
        }
        Insert: {
          auto_done?: boolean
          auto_start?: boolean
          color?: string
          id: string
          is_done?: boolean
          name: string
          sort_order?: number
        }
        Update: {
          auto_done?: boolean
          auto_start?: boolean
          color?: string
          id?: string
          is_done?: boolean
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      task_attachments: {
        Row: {
          created_at: string
          file_name: string
          file_size: number
          file_type: string
          id: string
          storage_path: string
          task_id: string
          uploaded_by: string
        }
        Insert: {
          created_at?: string
          file_name: string
          file_size?: number
          file_type?: string
          id?: string
          storage_path: string
          task_id: string
          uploaded_by?: string
        }
        Update: {
          created_at?: string
          file_name?: string
          file_size?: number
          file_type?: string
          id?: string
          storage_path?: string
          task_id?: string
          uploaded_by?: string
        }
        Relationships: []
      }
      task_checks: {
        Row: {
          id: string
          is_done: boolean
          sort_order: number
          task_id: string
          text: string
        }
        Insert: {
          id: string
          is_done?: boolean
          sort_order?: number
          task_id: string
          text: string
        }
        Update: {
          id?: string
          is_done?: boolean
          sort_order?: number
          task_id?: string
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_checks_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_deployments: {
        Row: {
          deploy_date: string | null
          environment: string
          id: string
          status: Database["public"]["Enums"]["deploy_status"]
          task_id: string
        }
        Insert: {
          deploy_date?: string | null
          environment: string
          id?: string
          status?: Database["public"]["Enums"]["deploy_status"]
          task_id: string
        }
        Update: {
          deploy_date?: string | null
          environment?: string
          id?: string
          status?: Database["public"]["Enums"]["deploy_status"]
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_deployments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_specs: {
        Row: {
          background: string
          id: string
          notes: string
          requirement: string
          task_id: string
        }
        Insert: {
          background?: string
          id: string
          notes?: string
          requirement?: string
          task_id: string
        }
        Update: {
          background?: string
          id?: string
          notes?: string
          requirement?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_specs_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: true
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_todos: {
        Row: {
          id: string
          is_done: boolean
          sort_order: number
          task_id: string
          text: string
        }
        Insert: {
          id: string
          is_done?: boolean
          sort_order?: number
          task_id: string
          text: string
        }
        Update: {
          id?: string
          is_done?: boolean
          sort_order?: number
          task_id?: string
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_todos_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assignee_id: string | null
          comment_count: number
          completed_at: string | null
          created_at: string
          creator_id: string
          department: string | null
          due_date: string | null
          gitlab_url: string | null
          id: string
          priority: Database["public"]["Enums"]["task_priority"]
          project_id: string
          reviewer_id: string | null
          sort_order: number
          sprint_id: string | null
          started_at: string | null
          status_id: string
          task_key: string
          title: string
        }
        Insert: {
          assignee_id?: string | null
          comment_count?: number
          completed_at?: string | null
          created_at?: string
          creator_id: string
          department?: string | null
          due_date?: string | null
          gitlab_url?: string | null
          id: string
          priority?: Database["public"]["Enums"]["task_priority"]
          project_id: string
          reviewer_id?: string | null
          sort_order?: number
          sprint_id?: string | null
          started_at?: string | null
          status_id: string
          task_key: string
          title: string
        }
        Update: {
          assignee_id?: string | null
          comment_count?: number
          completed_at?: string | null
          created_at?: string
          creator_id?: string
          department?: string | null
          due_date?: string | null
          gitlab_url?: string | null
          id?: string
          priority?: Database["public"]["Enums"]["task_priority"]
          project_id?: string
          reviewer_id?: string | null
          sort_order?: number
          sprint_id?: string | null
          started_at?: string | null
          status_id?: string
          task_key?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_sprint_id_fkey"
            columns: ["sprint_id"]
            isOneToOne: false
            referencedRelation: "sprints"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_status_id_fkey"
            columns: ["status_id"]
            isOneToOne: false
            referencedRelation: "statuses"
            referencedColumns: ["id"]
          },
        ]
      }
      user_column_configs: {
        Row: {
          id: string
          member_id: string
          updated_at: string
          view_key: string
          visible_keys: Json
        }
        Insert: {
          id?: string
          member_id: string
          updated_at?: string
          view_key: string
          visible_keys?: Json
        }
        Update: {
          id?: string
          member_id?: string
          updated_at?: string
          view_key?: string
          visible_keys?: Json
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      app_member_role: "admin" | "member" | "super_admin"
      deploy_environment: "Dev" | "QA" | "Stage" | "Live Staging" | "Prod"
      deploy_status: "deployed" | "scheduled"
      task_priority: "highest" | "high" | "medium" | "low" | "lowest"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never
