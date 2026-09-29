-- ============================================================
-- Migration: Server-side notification dispatch (email + webhooks)
-- Date: 2026-07-14
--
-- 1. Email pipeline — AFTER INSERT ON public.notifications:
--    reads the email_config singleton (customer-bound Resend key, set via
--    the email-config Edge Function; server-only table) + the recipient's
--    user_notification_preferences and fires an async net.http_post to
--    Resend. pg_net is fire-and-forget: the INSERT that created the
--    notification is never blocked or failed by mail problems (the whole
--    trigger body is EXCEPTION-guarded on top of that).
--
--    notifications.type → email preference key mapping (frontend inserts
--    these exact type strings — see src/components/task-detail/utils.ts
--    createNotification callers and src/context/hooks/useSideEffects.ts):
--        'assign'   → 'assigned'    (被指派為負責人)
--        'mention'  → 'mentioned'   (在留言/規格中被 @提及)
--        'due_soon' → 'due_soon'    (截止日提醒；due-reminders Edge Function
--                                    也插入同一個 type)
--    Any other type ('review', 'comment', 'comment_reply', 'status_changed',
--    'system', 'approval_requested', 'approval_completed',
--    'unauthorized_login', …) does NOT email — in-app only.
--
-- 2. Webhook pipeline — AFTER INSERT/UPDATE/DELETE ON public.tasks and
--    AFTER INSERT ON public.comments: loops enabled webhook_configs whose
--    events array contains the mapped event name and fires a signed
--    net.http_post to each URL. Signature = hex HMAC-SHA256 of the exact
--    request body (the jsonb payload's canonical text form — pg_net sends
--    body::text verbatim, so receivers can verify byte-for-byte) with the
--    per-hook secret, delivered in X-Livo-Signature. Event name rides in
--    X-Livo-Event. last_status is set to 'queued' (pg_net is async — the
--    real HTTP outcome is never known inside the transaction).
--
-- Requires: pg_net + pgcrypto extensions (both already CREATE EXTENSION
-- IF NOT EXISTS'd by earlier migrations) and the email_config /
-- webhook_configs / user_notification_preferences pieces from
-- 20260714_features_base.sql.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.
-- ============================================================

-- ── 1. Email dispatch on notification insert ─────────────────────────────
-- SECURITY DEFINER: email_config is RLS-locked with zero policies (server
-- only); the trigger runs as the table owner so it can read the key while
-- clients never can. search_path includes extensions so bare hmac()/pg_net
-- helpers resolve correctly.

CREATE OR REPLACE FUNCTION public.livo_notify_email_dispatch()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $livo_email$
DECLARE
  pref_key        text;
  cfg_api_key     text;
  cfg_from        text;
  rcpt_email      text;
  pref_enabled    boolean;
  pref_types      jsonb;
  mail_subject    text;
  mail_html       text;
  safe_content    text;
BEGIN
  -- Never let mail plumbing break the notification insert itself.
  BEGIN
    -- Map notification type → preference key; unmatched types never email.
    pref_key := CASE NEW.type
      WHEN 'assign'   THEN 'assigned'
      WHEN 'mention'  THEN 'mentioned'
      WHEN 'due_soon' THEN 'due_soon'
      ELSE NULL
    END;
    IF pref_key IS NULL THEN
      RETURN NEW;
    END IF;

    -- Customer-bound Resend config (singleton). Missing/blank → no email.
    SELECT api_key, from_address INTO cfg_api_key, cfg_from
      FROM public.email_config
     WHERE id = 'singleton';
    IF cfg_api_key IS NULL OR cfg_api_key = ''
       OR cfg_from IS NULL OR cfg_from = '' THEN
      RETURN NEW;
    END IF;

    -- Recipient must be a member with a plausible email.
    SELECT email INTO rcpt_email
      FROM public.members
     WHERE id = NEW.recipient_id;
    IF rcpt_email IS NULL OR rcpt_email = '' OR rcpt_email NOT LIKE '%@%' THEN
      RETURN NEW;
    END IF;

    -- Preferences: absent row = enabled, all types.
    SELECT email_notify_enabled, email_notify_types
      INTO pref_enabled, pref_types
      FROM public.user_notification_preferences
     WHERE user_id = NEW.recipient_id;
    IF FOUND THEN
      IF NOT COALESCE(pref_enabled, true) THEN
        RETURN NEW;
      END IF;
      IF pref_types IS NOT NULL
         AND jsonb_typeof(pref_types) = 'array'
         AND NOT (pref_types ? pref_key) THEN
        RETURN NEW;
      END IF;
    END IF;

    mail_subject := 'LIVO 通知：' || CASE pref_key
      WHEN 'assigned'  THEN '您被指派了新任務'
      WHEN 'mentioned' THEN '有人在留言中提及您'
      ELSE                  '任務即將到期'
    END;

    -- Minimal HTML-escape of user-supplied content.
    safe_content := replace(replace(replace(COALESCE(NEW.content, ''),
                      '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
    mail_html := '<p>' || safe_content || '</p>'
              || '<p style="color:#6B778C;font-size:13px">請至 LIVO 查看詳情。</p>';

    -- Async fire-and-forget (queued by pg_net; a background worker sends it).
    PERFORM net.http_post(
      url     := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || cfg_api_key
      ),
      body    := jsonb_build_object(
        'from',    cfg_from,
        'to',      jsonb_build_array(rcpt_email),
        'subject', mail_subject,
        'html',    mail_html
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[livo_notify_email_dispatch] % (notification % type %)',
      SQLERRM, NEW.id, NEW.type;
  END;
  RETURN NEW;
END;
$livo_email$;

DROP TRIGGER IF EXISTS livo_notify_email_dispatch ON public.notifications;
CREATE TRIGGER livo_notify_email_dispatch
  AFTER INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.livo_notify_email_dispatch();

-- ── 2. Webhook dispatch on task / comment changes ────────────────────────
-- One function serves both tables; TG_TABLE_NAME + TG_OP pick the event:
--   tasks    INSERT → task_created / UPDATE → task_updated / DELETE → task_deleted
--   comments INSERT → comment_added
-- DELETE payloads carry the full OLD row (parity with the realtime contract).

CREATE OR REPLACE FUNCTION public.livo_webhook_dispatch()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $livo_hook$
DECLARE
  evt      text;
  row_data jsonb;
  payload  jsonb;
  sig      text;
  hook     record;
BEGIN
  BEGIN
    IF TG_TABLE_NAME = 'comments' THEN
      IF TG_OP <> 'INSERT' THEN
        RETURN COALESCE(NEW, OLD);
      END IF;
      evt := 'comment_added';
    ELSE
      evt := CASE TG_OP
        WHEN 'INSERT' THEN 'task_created'
        WHEN 'UPDATE' THEN 'task_updated'
        WHEN 'DELETE' THEN 'task_deleted'
      END;
    END IF;

    row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;

    FOR hook IN
      SELECT id, url, secret
        FROM public.webhook_configs
       WHERE enabled
         AND jsonb_typeof(events) = 'array'
         AND events ? evt
    LOOP
      payload := jsonb_build_object(
        'event',     evt,
        'timestamp', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'data',      row_data
      );
      -- pg_net sends the jsonb body as its canonical text form; signing that
      -- exact text lets receivers verify the raw request body byte-for-byte.
      sig := encode(hmac(payload::text, hook.secret, 'sha256'), 'hex');

      PERFORM net.http_post(
        url     := hook.url,
        headers := jsonb_build_object(
          'Content-Type',     'application/json',
          'X-Livo-Event',     evt,
          'X-Livo-Signature', sig
        ),
        body    := payload
      );

      -- pg_net is async: the HTTP result is unknowable here. Record that the
      -- delivery was queued; the timestamp doubles as "last activity".
      UPDATE public.webhook_configs
         SET last_status  = 'queued',
             last_sent_at = now()
       WHERE id = hook.id;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[livo_webhook_dispatch] % (% on %)', SQLERRM, TG_OP, TG_TABLE_NAME;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$livo_hook$;

DROP TRIGGER IF EXISTS livo_webhook_dispatch_tasks ON public.tasks;
CREATE TRIGGER livo_webhook_dispatch_tasks
  AFTER INSERT OR UPDATE OR DELETE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.livo_webhook_dispatch();

DROP TRIGGER IF EXISTS livo_webhook_dispatch_comments ON public.comments;
CREATE TRIGGER livo_webhook_dispatch_comments
  AFTER INSERT ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.livo_webhook_dispatch();
