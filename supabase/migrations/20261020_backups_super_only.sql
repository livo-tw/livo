-- JSON backups can be read only by an active super_admin.
--
-- 20260309050127 gave the private backups bucket two policies, both for every
-- signed-in session: "Authenticated users can read backups" (SELECT) and
-- "Service role can insert backups" (INSERT, despite its name, TO authenticated).
-- A backup holds every member's e-mail, all tasks, comments, notifications,
-- approvals and the service-only QA tables. Any member could download all of
-- them, and so could a login with no member (the active-member gate,
-- 20261019_active_member_gate.sql, covers schema public, not storage). Anyone
-- signed in could also upload a file that a super_admin might later restore.
--
-- Only the System admin page downloads or deletes backups, and it is
-- super_admin-only. scheduled-backup writes them with the service role, which
-- row security does not apply to. The RESTRICTIVE policies below are ANDed with
-- the existing ones: backup files are read or deleted by an active super_admin
-- only and never written by a session. Other buckets are not affected.
-- (backup_history writes were already limited by 20260713_permission_floor.sql.)
-- Repeatable: DROP POLICY IF EXISTS before CREATE; no row is touched.
DROP POLICY IF EXISTS livo_backups_super_read ON storage.objects;
CREATE POLICY livo_backups_super_read ON storage.objects AS RESTRICTIVE FOR SELECT TO public
  USING (bucket_id <> 'backups' OR (public.livo_is_active_member() AND public.is_livo_super()));

DROP POLICY IF EXISTS livo_backups_super_delete ON storage.objects;
CREATE POLICY livo_backups_super_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO public
  USING (bucket_id <> 'backups' OR (public.livo_is_active_member() AND public.is_livo_super()));

-- The System admin page's "delete backup" removed only the history row: no
-- policy allowed deleting the file. An active super_admin may now delete it.
DROP POLICY IF EXISTS livo_backups_super_remove ON storage.objects;
CREATE POLICY livo_backups_super_remove ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'backups' AND public.livo_is_active_member() AND public.is_livo_super());

DROP POLICY IF EXISTS livo_backups_no_session_insert ON storage.objects;
CREATE POLICY livo_backups_no_session_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO public
  WITH CHECK (bucket_id <> 'backups');

DROP POLICY IF EXISTS livo_backups_no_session_update ON storage.objects;
CREATE POLICY livo_backups_no_session_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO public
  USING (bucket_id <> 'backups') WITH CHECK (bucket_id <> 'backups');
