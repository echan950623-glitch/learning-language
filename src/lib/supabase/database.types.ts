/**
 * 手寫的 Supabase `public` schema 型別，精確對應
 * `supabase/migrations/20260916010000_cloud_sync_tables.sql` 與
 * `supabase/migrations/20260916030000_cloud_sync_rpc_functions.sql` 實際套用到專案的
 * 結構（已用 information_schema／pg_policies／pg_proc 驗證過與此檔案一致）。
 *
 * 這個專案沒有已連結、已認證的 `supabase` CLI（見交付報告），所以這個檔案是手寫的，
 * 不是 `supabase gen types typescript` 產生的。之後如果 CLI 可用，可以直接用
 * `supabase gen types typescript --project-id yhtxddaiofasliaflqqr` 重新產生並取代這個
 * 檔案；欄位命名與型別的取捨（例如帶 CHECK constraint 的欄位一律用 `string`、不展開成
 * literal union；`generated always as` 欄位不出現在 Insert／Update）刻意比照 CLI 的
 * 實際產出慣例，讓之後重新產生時 diff 最小。
 *
 * Row：查詢結果的形狀。Insert：`.insert()` 允許的形狀（有 DEFAULT 或允許 NULL 的欄位
 * 是 optional）。Update：`.update()` 允許的形狀（全部欄位 optional）。
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      learning_items: {
        Row: {
          id: string;
          user_id: string;
          language: string;
          type: string;
          prompt_zh: string;
          answer: string;
          reading: string | null;
          explanation: string | null;
          romaji: string | null;
          part_of_speech: string | null;
          example_sentence: string | null;
          source: string;
          tags: string[];
          status: string;
          created_at: string;
          is_seed: boolean;
          /** `generated always as (...) stored`，只讀，不能寫入。 */
          content_key: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          user_id: string;
          language: string;
          type: string;
          prompt_zh: string;
          answer: string;
          reading?: string | null;
          explanation?: string | null;
          romaji?: string | null;
          part_of_speech?: string | null;
          example_sentence?: string | null;
          source: string;
          tags?: string[];
          status: string;
          created_at: string;
          is_seed?: boolean;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          language?: string;
          type?: string;
          prompt_zh?: string;
          answer?: string;
          reading?: string | null;
          explanation?: string | null;
          romaji?: string | null;
          part_of_speech?: string | null;
          example_sentence?: string | null;
          source?: string;
          tags?: string[];
          status?: string;
          created_at?: string;
          is_seed?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      schedule_states: {
        Row: {
          user_id: string;
          learning_item_id: string;
          ability: string;
          language: string;
          due_at: string;
          interval_days: number;
          streak: number;
          lapse_count: number;
          last_reviewed_at: string | null;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          learning_item_id: string;
          ability: string;
          language: string;
          due_at: string;
          interval_days: number;
          streak: number;
          lapse_count: number;
          last_reviewed_at?: string | null;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          learning_item_id?: string;
          ability?: string;
          language?: string;
          due_at?: string;
          interval_days?: number;
          streak?: number;
          lapse_count?: number;
          last_reviewed_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "schedule_states_learning_item_id_fkey";
            columns: ["learning_item_id"];
            isOneToOne: false;
            referencedRelation: "learning_items";
            referencedColumns: ["id"];
          },
        ];
      };
      study_sessions: {
        Row: {
          id: string;
          user_id: string;
          language: string;
          status: string;
          started_at: string;
          completed_at: string | null;
          planned_units: Json;
          new_item_ids: string[];
          review_item_ids: string[];
          updated_at: string;
        };
        Insert: {
          id: string;
          user_id: string;
          language: string;
          status: string;
          started_at: string;
          completed_at?: string | null;
          planned_units: Json;
          new_item_ids?: string[];
          review_item_ids?: string[];
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          language?: string;
          status?: string;
          started_at?: string;
          completed_at?: string | null;
          planned_units?: Json;
          new_item_ids?: string[];
          review_item_ids?: string[];
          updated_at?: string;
        };
        Relationships: [];
      };
      review_attempts: {
        Row: {
          id: string;
          user_id: string;
          session_id: string;
          sequence_in_session: number;
          /** `generated always as identity`，只讀，不能寫入。 */
          seq: number;
          exercise_id: string;
          learning_item_id: string;
          language: string;
          exercise_type: string;
          result: string;
          used_hint: boolean;
          response_time_ms: number;
          reviewed_at: string;
        };
        Insert: {
          id: string;
          user_id: string;
          session_id: string;
          sequence_in_session: number;
          exercise_id: string;
          learning_item_id: string;
          language: string;
          exercise_type: string;
          result: string;
          used_hint: boolean;
          response_time_ms: number;
          reviewed_at: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          session_id?: string;
          sequence_in_session?: number;
          exercise_id?: string;
          learning_item_id?: string;
          language?: string;
          exercise_type?: string;
          result?: string;
          used_hint?: boolean;
          response_time_ms?: number;
          reviewed_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "review_attempts_learning_item_id_fkey";
            columns: ["learning_item_id"];
            isOneToOne: false;
            referencedRelation: "learning_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_attempts_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "study_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      user_preferences: {
        Row: {
          user_id: string;
          daily_question_count: number;
          daily_new_item_cap: number;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          daily_question_count?: number;
          daily_new_item_cap?: number;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          daily_question_count?: number;
          daily_new_item_cap?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      record_graded_attempt: {
        Args: { payload: Json };
        Returns: Json;
      };
      mark_attempt_correct: {
        Args: { payload: Json };
        Returns: Json;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
