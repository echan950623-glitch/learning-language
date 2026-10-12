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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      daily_learning_plans: {
        Row: {
          id: string
          plan: Json
          user_id: string
        }
        Insert: {
          id: string
          plan: Json
          user_id: string
        }
        Update: {
          id?: string
          plan?: Json
          user_id?: string
        }
        Relationships: []
      }
      learning_data_revisions: {
        Row: {
          revision: number
          user_id: string
        }
        Insert: {
          revision?: number
          user_id: string
        }
        Update: {
          revision?: number
          user_id?: string
        }
        Relationships: []
      }
      learning_items: {
        Row: {
          answer: string
          archived_at: string | null
          content_key: string | null
          created_at: string
          example_sentence: string | null
          explanation: string | null
          id: string
          is_seed: boolean
          language: string
          learning_metadata: Json
          part_of_speech: string | null
          prompt_zh: string
          reading: string | null
          romaji: string | null
          source: string
          status: string
          tags: string[]
          type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          answer: string
          archived_at?: string | null
          content_key?: string | null
          created_at: string
          example_sentence?: string | null
          explanation?: string | null
          id: string
          is_seed?: boolean
          language: string
          learning_metadata?: Json
          part_of_speech?: string | null
          prompt_zh: string
          reading?: string | null
          romaji?: string | null
          source: string
          status: string
          tags?: string[]
          type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          answer?: string
          archived_at?: string | null
          content_key?: string | null
          created_at?: string
          example_sentence?: string | null
          explanation?: string | null
          id?: string
          is_seed?: boolean
          language?: string
          learning_metadata?: Json
          part_of_speech?: string | null
          prompt_zh?: string
          reading?: string | null
          romaji?: string | null
          source?: string
          status?: string
          tags?: string[]
          type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      review_attempts: {
        Row: {
          exercise_id: string
          exercise_type: string
          id: string
          language: string
          learning_item_id: string
          learning_metadata: Json | null
          response_time_ms: number
          result: string
          reviewed_at: string
          seq: number
          sequence_in_session: number
          session_id: string
          used_hint: boolean
          user_id: string
        }
        Insert: {
          exercise_id: string
          exercise_type: string
          id: string
          language: string
          learning_item_id: string
          learning_metadata?: Json | null
          response_time_ms: number
          result: string
          reviewed_at: string
          seq?: never
          sequence_in_session: number
          session_id: string
          used_hint: boolean
          user_id: string
        }
        Update: {
          exercise_id?: string
          exercise_type?: string
          id?: string
          language?: string
          learning_item_id?: string
          learning_metadata?: Json | null
          response_time_ms?: number
          result?: string
          reviewed_at?: string
          seq?: never
          sequence_in_session?: number
          session_id?: string
          used_hint?: boolean
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_attempts_learning_item_id_fkey"
            columns: ["learning_item_id"]
            isOneToOne: false
            referencedRelation: "learning_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_attempts_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "study_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_states: {
        Row: {
          ability: string
          due_at: string
          interval_days: number
          language: string
          lapse_count: number
          last_reviewed_at: string | null
          learning_item_id: string
          learning_metadata: Json
          streak: number
          updated_at: string
          user_id: string
        }
        Insert: {
          ability: string
          due_at: string
          interval_days: number
          language: string
          lapse_count: number
          last_reviewed_at?: string | null
          learning_item_id: string
          learning_metadata?: Json
          streak: number
          updated_at?: string
          user_id: string
        }
        Update: {
          ability?: string
          due_at?: string
          interval_days?: number
          language?: string
          lapse_count?: number
          last_reviewed_at?: string | null
          learning_item_id?: string
          learning_metadata?: Json
          streak?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_states_learning_item_id_fkey"
            columns: ["learning_item_id"]
            isOneToOne: false
            referencedRelation: "learning_items"
            referencedColumns: ["id"]
          },
        ]
      }
      study_sessions: {
        Row: {
          completed_at: string | null
          id: string
          language: string
          learning_metadata: Json
          new_item_ids: string[]
          planned_units: Json
          review_item_ids: string[]
          started_at: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          id: string
          language: string
          learning_metadata?: Json
          new_item_ids?: string[]
          planned_units: Json
          review_item_ids?: string[]
          started_at: string
          status: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          id?: string
          language?: string
          learning_metadata?: Json
          new_item_ids?: string[]
          planned_units?: Json
          review_item_ids?: string[]
          started_at?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_preferences: {
        Row: {
          daily_new_item_cap: number
          daily_question_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          daily_new_item_cap?: number
          daily_question_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          daily_new_item_cap?: number
          daily_question_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      abandon_study_session_guarded: { Args: { payload: Json }; Returns: Json }
      archive_learning_items_guarded: {
        Args: { payload: Json }
        Returns: undefined
      }
      commit_learning_event: { Args: { payload: Json }; Returns: Json }
      delete_learning_items_guarded: {
        Args: { payload: Json }
        Returns: number
      }
      get_learning_revision: { Args: never; Returns: string }
      mark_attempt_correct: { Args: { payload: Json }; Returns: Json }
      record_graded_attempt: { Args: { payload: Json }; Returns: Json }
      reserve_daily_plan: { Args: { payload: Json }; Returns: Json }
      upsert_learning_item_guarded: { Args: { payload: Json }; Returns: Json }
      upsert_preferences_guarded: { Args: { payload: Json }; Returns: Json }
      upsert_review_attempt_guarded: { Args: { payload: Json }; Returns: Json }
      upsert_schedule_state_guarded: { Args: { payload: Json }; Returns: Json }
      upsert_study_session_guarded: { Args: { payload: Json }; Returns: Json }
    }
    Enums: {
      [_ in never]: never
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
