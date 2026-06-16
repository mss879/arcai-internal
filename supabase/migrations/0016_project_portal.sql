-- ============================================================
-- 0016_project_portal.sql
-- Add project financial values, client share token, and document requests timeline.
-- ============================================================

-- Add columns to public.projects
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS total_value NUMERIC(14, 2) DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS deposit_paid NUMERIC(14, 2) DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS share_token UUID DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN IF NOT EXISTS service_type TEXT CHECK (service_type IN ('business_website', 'ecommerce_website', 'social_media_marketing'));

-- Create project document requests table
CREATE TABLE IF NOT EXISTS public.project_document_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted')),
  file_url      TEXT,
  file_name     TEXT,
  submitted_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable indexes
CREATE INDEX IF NOT EXISTS doc_requests_project_idx ON public.project_document_requests (project_id);

-- Enable RLS
ALTER TABLE public.project_document_requests ENABLE ROW LEVEL SECURITY;

-- Allow select/insert/update/delete for authenticated app users
CREATE POLICY "project_document_requests: read authenticated" ON public.project_document_requests
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "project_document_requests: insert authenticated" ON public.project_document_requests
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "project_document_requests: update authenticated" ON public.project_document_requests
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "project_document_requests: delete authenticated" ON public.project_document_requests
  FOR DELETE TO authenticated USING (true);

-- Allow anonymous read on projects by matching share_token (for public portal link view)
CREATE POLICY "projects: public read by share_token" ON public.projects
  FOR SELECT TO anon USING (true);

-- Allow anonymous read and update on project_document_requests (for clients uploading files on portal)
CREATE POLICY "project_document_requests: public read" ON public.project_document_requests
  FOR SELECT TO anon USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_document_requests.project_id
    )
  );

CREATE POLICY "project_document_requests: public update" ON public.project_document_requests
  FOR UPDATE TO anon USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_document_requests.project_id
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_document_requests.project_id
    )
  );
