/**
 * Hand-authored database types.
 *
 * Keep this in sync with the SQL migrations in `supabase/migrations`.
 * After you run the migrations you can replace this file with the
 * auto-generated types via:
 *   npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts
 */

type Timestamp = string;
type UUID = string;

export type UserRole = "admin" | "member";
export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";
export type ClientStatus = "active" | "lead" | "inactive";
export type TodoPriority = "low" | "medium" | "high" | "urgent";
export type TodoStatus = "todo" | "in_progress" | "done";
export type ProjectStatus =
  | "planning"
  | "active"
  | "on_hold"
  | "completed"
  | "cancelled";
export type PaymentStatus = "pending" | "paid" | "overdue";
export type CommissionStatus = "pending" | "approved" | "paid";
export type ResourceKind = "file" | "link";
export type BookingStatus = "confirmed" | "cancelled";
export type NotificationType =
  | "mention"
  | "assignment"
  | "commission"
  | "system";

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: UUID;
          full_name: string;
          username: string;
          email: string;
          role: UserRole;
          title: string | null;
          avatar_url: string | null;
          created_at: Timestamp;
        };
        Insert: {
          id: UUID;
          full_name: string;
          username: string;
          email: string;
          role?: UserRole;
          title?: string | null;
          avatar_url?: string | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
        Relationships: [];
      };
      invitations: {
        Row: {
          id: UUID;
          email: string;
          role: UserRole;
          token: string;
          status: InviteStatus;
          invited_by: UUID | null;
          accepted_at: Timestamp | null;
          expires_at: Timestamp;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          email: string;
          role?: UserRole;
          token: string;
          status?: InviteStatus;
          invited_by?: UUID | null;
          accepted_at?: Timestamp | null;
          expires_at?: Timestamp;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["invitations"]["Insert"]>;
        Relationships: [];
      };
      clients: {
        Row: {
          id: UUID;
          name: string;
          company: string | null;
          email: string | null;
          phone: string | null;
          city: string | null;
          status: ClientStatus;
          notes: string | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name: string;
          company?: string | null;
          email?: string | null;
          phone?: string | null;
          city?: string | null;
          status?: ClientStatus;
          notes?: string | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["clients"]["Insert"]>;
        Relationships: [];
      };
      todos: {
        Row: {
          id: UUID;
          title: string;
          description: string | null;
          priority: TodoPriority;
          status: TodoStatus;
          due_date: Timestamp | null;
          assigned_to: UUID | null;
          created_by: UUID | null;
          completed_at: Timestamp | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          title: string;
          description?: string | null;
          priority?: TodoPriority;
          status?: TodoStatus;
          due_date?: Timestamp | null;
          assigned_to?: UUID | null;
          created_by?: UUID | null;
          completed_at?: Timestamp | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["todos"]["Insert"]>;
        Relationships: [];
      };
      todo_mentions: {
        Row: {
          id: UUID;
          todo_id: UUID;
          user_id: UUID;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          todo_id: UUID;
          user_id: UUID;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["todo_mentions"]["Insert"]>;
        Relationships: [];
      };
      projects: {
        Row: {
          id: UUID;
          name: string;
          description: string | null;
          client_id: UUID | null;
          status: ProjectStatus;
          budget: number | null;
          currency: string;
          start_date: string | null;
          due_date: string | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name: string;
          description?: string | null;
          client_id?: UUID | null;
          status?: ProjectStatus;
          budget?: number | null;
          currency?: string;
          start_date?: string | null;
          due_date?: string | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["projects"]["Insert"]>;
        Relationships: [];
      };
      company_payments: {
        Row: {
          id: UUID;
          company_name: string;
          price_lkr: number;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          company_name: string;
          price_lkr: number;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["company_payments"]["Insert"]>;
        Relationships: [];
      };
      payments: {
        Row: {
          id: UUID;
          project_id: UUID;
          amount: number;
          currency: string;
          status: PaymentStatus;
          paid_at: string | null;
          method: string | null;
          notes: string | null;
          receipt_url: string | null;
          receipt_path: string | null;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          project_id: UUID;
          amount: number;
          currency?: string;
          status?: PaymentStatus;
          paid_at?: string | null;
          method?: string | null;
          notes?: string | null;
          receipt_url?: string | null;
          receipt_path?: string | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["payments"]["Insert"]>;
        Relationships: [];
      };
      commissions: {
        Row: {
          id: UUID;
          project_id: UUID | null;
          payment_id: UUID | null;
          user_id: UUID;
          amount: number;
          percentage: number | null;
          status: CommissionStatus;
          note: string | null;
          allocated_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          project_id?: UUID | null;
          payment_id?: UUID | null;
          user_id: UUID;
          amount: number;
          percentage?: number | null;
          status?: CommissionStatus;
          note?: string | null;
          allocated_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["commissions"]["Insert"]>;
        Relationships: [];
      };
      resources: {
        Row: {
          id: UUID;
          name: string;
          description: string | null;
          kind: ResourceKind;
          file_url: string | null;
          file_path: string | null;
          file_type: string | null;
          file_size: number | null;
          link_url: string | null;
          uploaded_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name: string;
          description?: string | null;
          kind?: ResourceKind;
          file_url?: string | null;
          file_path?: string | null;
          file_type?: string | null;
          file_size?: number | null;
          link_url?: string | null;
          uploaded_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["resources"]["Insert"]>;
        Relationships: [];
      };
      meeting_links: {
        Row: {
          id: UUID;
          slug: string;
          title: string;
          description: string | null;
          duration_minutes: number;
          start_hour: number;
          end_hour: number;
          advance_days: number;
          location: string | null;
          active: boolean;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          slug: string;
          title: string;
          description?: string | null;
          duration_minutes?: number;
          start_hour?: number;
          end_hour?: number;
          advance_days?: number;
          location?: string | null;
          active?: boolean;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["meeting_links"]["Insert"]>;
        Relationships: [];
      };
      meeting_bookings: {
        Row: {
          id: UUID;
          meeting_link_id: UUID;
          client_name: string;
          client_email: string | null;
          client_phone: string | null;
          notes: string | null;
          booking_date: string;
          start_time: string;
          end_time: string;
          status: BookingStatus;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          meeting_link_id: UUID;
          client_name: string;
          client_email?: string | null;
          client_phone?: string | null;
          notes?: string | null;
          booking_date: string;
          start_time: string;
          end_time: string;
          status?: BookingStatus;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["meeting_bookings"]["Insert"]
        >;
        Relationships: [];
      };
      pipelines: {
        Row: {
          id: UUID;
          name: string;
          description: string | null;
          position: number;
          created_by: UUID | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          name: string;
          description?: string | null;
          position?: number;
          created_by?: UUID | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["pipelines"]["Insert"]>;
        Relationships: [];
      };
      pipeline_stages: {
        Row: {
          id: UUID;
          pipeline_id: UUID;
          name: string;
          color: string;
          position: number;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          pipeline_id: UUID;
          name: string;
          color?: string;
          position?: number;
          created_at?: Timestamp;
        };
        Update: Partial<
          Database["public"]["Tables"]["pipeline_stages"]["Insert"]
        >;
        Relationships: [];
      };
      leads: {
        Row: {
          id: UUID;
          pipeline_id: UUID;
          stage_id: UUID | null;
          title: string;
          company: string | null;
          contact_name: string | null;
          contact_email: string | null;
          contact_phone: string | null;
          value: number | null;
          currency: string;
          notes: string | null;
          position: number;
          assigned_to: UUID | null;
          client_id: UUID | null;
          created_by: UUID | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          pipeline_id: UUID;
          stage_id?: UUID | null;
          title: string;
          company?: string | null;
          contact_name?: string | null;
          contact_email?: string | null;
          contact_phone?: string | null;
          value?: number | null;
          currency?: string;
          notes?: string | null;
          position?: number;
          assigned_to?: UUID | null;
          client_id?: UUID | null;
          created_by?: UUID | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["leads"]["Insert"]>;
        Relationships: [];
      };
      notifications: {
        Row: {
          id: UUID;
          user_id: UUID;
          actor_id: UUID | null;
          type: NotificationType;
          title: string;
          body: string | null;
          link: string | null;
          read: boolean;
          created_at: Timestamp;
        };
        Insert: {
          id?: UUID;
          user_id: UUID;
          actor_id?: UUID | null;
          type: NotificationType;
          title: string;
          body?: string | null;
          link?: string | null;
          read?: boolean;
          created_at?: Timestamp;
        };
        Update: Partial<Database["public"]["Tables"]["notifications"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: {
      is_admin: {
        Args: { uid: UUID };
        Returns: boolean;
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
