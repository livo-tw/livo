-- One login belongs to at most one member.
--
-- members.auth_id had an index but no unique constraint. manage-member's
-- "create" adopted an existing login found by e-mail without checking that no
-- other member was linked to it, and the duplicate-member check compared e-mails
-- case-sensitively. An admin could therefore create a member whose e-mail
-- differed only in case from a super_admin's, linking a second member row to the
-- super_admin's login: current_member_id() and current_member_role() read
-- "LIMIT 1", so that person's role became unpredictable, and deleting the
-- duplicate deleted the super_admin's login. manage-member now refuses this; the
-- index makes the database refuse it too.
--
-- If an install already has two members on one login, the index is not created
-- (a warning names how many logins are shared) so the upgrade still completes.
-- The file is still recorded as applied, so a later upgrade does not retry it:
-- after a super_admin fixes the rows, run the CREATE UNIQUE INDEX below by hand
-- (docs/post-merge-runbook.md, C2 "shared_logins").
-- Repeatable: CREATE UNIQUE INDEX IF NOT EXISTS; no row is touched.
DO $livo_member_login$
DECLARE
  shared integer;
BEGIN
  SELECT count(*) INTO shared FROM (
    SELECT auth_id FROM public.members WHERE auth_id IS NOT NULL GROUP BY auth_id HAVING count(*) > 1
  ) d;
  IF shared > 0 THEN
    RAISE WARNING 'members: % login(s) are linked to more than one member; members_auth_id_unique was not created', shared;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS members_auth_id_unique ON public.members (auth_id) WHERE auth_id IS NOT NULL;
  END IF;
END
$livo_member_login$;
