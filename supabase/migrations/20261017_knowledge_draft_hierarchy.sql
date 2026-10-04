-- A shared knowledge page cannot be moved under a private draft.
--
-- kb_work_page_guard (20261012_knowledge_work.sql) only freezes parent/ACL
-- when the page being changed is itself a draft, and kb_acl_guard
-- (20261007_knowledge_permissions.sql) lets an administrator reparent any
-- visible page under a page they can edit, which includes their own private
-- draft. Moving a shared page (and with it its children) under a draft made it
-- invisible to every other member, including super_admin.
--
-- Rule: when parent_id changes, the new parent chain may contain a private
-- draft only if the page was already inside a private draft (its own row or
-- an ancestor). Sharing a draft (the draft itself leaves its private state)
-- and moves within a draft subtree are unaffected. Applies to every role,
-- including the internal knowledge-work command path.
CREATE OR REPLACE FUNCTION public.kb_draft_hierarchy_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.parent_id IS NULL OR NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN RETURN NEW; END IF;
 IF EXISTS(
   WITH RECURSIVE target_chain(id,parent_id,owner,depth) AS (
    SELECT p.id,p.parent_id,p.private_draft_owner_id,1 FROM public.kb_pages p WHERE p.id=NEW.parent_id
    UNION ALL SELECT p.id,p.parent_id,p.private_draft_owner_id,t.depth+1 FROM public.kb_pages p JOIN target_chain t ON p.id=t.parent_id WHERE t.depth<10
   ) SELECT 1 FROM target_chain WHERE owner IS NOT NULL)
  AND NOT EXISTS(
   WITH RECURSIVE source_chain(id,parent_id,owner,depth) AS (
    SELECT OLD.id,OLD.parent_id,OLD.private_draft_owner_id,1
    UNION ALL SELECT p.id,p.parent_id,p.private_draft_owner_id,s.depth+1 FROM public.kb_pages p JOIN source_chain s ON p.id=s.parent_id WHERE s.depth<10
   ) SELECT 1 FROM source_chain WHERE owner IS NOT NULL)
 THEN
  RAISE EXCEPTION 'kb_private_draft_parent' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.kb_draft_hierarchy_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS kb_draft_hierarchy_guard ON public.kb_pages;
CREATE TRIGGER kb_draft_hierarchy_guard BEFORE UPDATE OF parent_id ON public.kb_pages FOR EACH ROW EXECUTE FUNCTION public.kb_draft_hierarchy_guard();
