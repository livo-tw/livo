-- Shared workspace media and live member presence must not be enumerable or
-- readable by QA-only logins (or the public anon key).
UPDATE storage.buckets SET public=false WHERE id='task-images' AND public;
DROP POLICY IF EXISTS livo_task_images_member_select ON storage.objects;
CREATE POLICY livo_task_images_member_select ON storage.objects AS RESTRICTIVE FOR SELECT TO public
  USING (bucket_id <> 'task-images' OR (SELECT public.livo_is_active_member()));
DROP POLICY IF EXISTS livo_task_images_member_update ON storage.objects;
CREATE POLICY livo_task_images_member_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO public
  USING (bucket_id <> 'task-images' OR (SELECT public.livo_is_active_member()))
  WITH CHECK (bucket_id <> 'task-images' OR (SELECT public.livo_is_active_member()));
DROP POLICY IF EXISTS livo_task_images_member_delete ON storage.objects;
CREATE POLICY livo_task_images_member_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO public
  USING (bucket_id <> 'task-images' OR (SELECT public.livo_is_active_member()));

-- Existing Presence publishers switch to private channels; permissions are
-- evaluated by Realtime on join. Do not turn on RLS here (owned by Realtime).
DROP POLICY IF EXISTS livo_presence_internal_read ON realtime.messages;
CREATE POLICY livo_presence_internal_read ON realtime.messages FOR SELECT TO authenticated
  USING (extension='presence' AND (SELECT public.livo_is_active_member()));
DROP POLICY IF EXISTS livo_presence_internal_write ON realtime.messages;
CREATE POLICY livo_presence_internal_write ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (extension='presence' AND (SELECT public.livo_is_active_member()));
DROP POLICY IF EXISTS livo_presence_member_floor ON realtime.messages;
CREATE POLICY livo_presence_member_floor ON realtime.messages AS RESTRICTIVE FOR ALL TO public
  USING (extension <> 'presence' OR (SELECT public.livo_is_active_member()))
  WITH CHECK (extension <> 'presence' OR (SELECT public.livo_is_active_member()));
