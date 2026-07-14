-- ============================================================
-- 0055_wa_language.sql
-- WhatsApp sales machine — Language Matching:
--
--   Detect and persist each contact's language — English, Sinhala,
--   Tamil, or romanized "Singlish"/"Tanglish" — so the agent replies
--   in it consistently, in the SAME SCRIPT they use, across live
--   replies, follow-up touches and promise follow-ups.
--
--   Detection is layered: native script is caught deterministically
--   by the webhook (Unicode ranges, free); romanized Sinhala/Tamil is
--   recognized by the agent itself via a new `set_language` tool;
--   voice notes carry Whisper's detected language.
--
--   wa_contacts     : + language ('en'|'si'|'ta'|'si-latn'|'ta-latn')
--   wa_agent_config : + language_matching master toggle
-- ============================================================

alter table public.wa_contacts
  add column if not exists language text
  check (language in ('en', 'si', 'ta', 'si-latn', 'ta-latn'));

alter table public.wa_agent_config
  add column if not exists language_matching boolean not null default true;

-- ---- Ensure the new agent tool is allowed on existing installs
update public.wa_agent_config
  set allowed_tools = allowed_tools || '{set_language}'
  where not ('set_language' = any(allowed_tools));
