-- Knowledge pages stay deletable after knowledge work touched them.
--
-- 20261012_knowledge_work.sql created its tables with ON DELETE RESTRICT to
-- kb_pages. Saving a private draft always writes a receipt and an event, so an
-- owner could never delete the own draft, and any member who linked a page as
-- a draft source blocked everyone from deleting that page.
--
-- Semantics (the page delete permission and RLS stay exactly as before):
--  * kb_work_receipts / kb_work_events of a page are command bookkeeping for
--    that page (receipts also hold the canonical command text, i.e. draft
--    content). They are removed together with the page.
--  * kb_source_links OWNED by a deleted page are removed with it.
--  * kb_source_links in other pages that POINT TO a deleted page (or to one of
--    its attachments) are removed. Keeping them would leave a draft that can be
--    neither shared nor unlinked because its source no longer exists.
--  * kb_publications follow their page. A publication of another page keeps
--    its own state and only loses the predecessor/successor pointer.
--  * A pinned revision still cannot be deleted on its own while a publication
--    or source link references it (deferred NO ACTION instead of RESTRICT).
--  * Child pages still block deleting their parent (unchanged).
-- Every statement is repeatable: constraints are dropped by name and re-added.
ALTER TABLE public.kb_work_receipts DROP CONSTRAINT IF EXISTS kb_work_receipts_page_id_fkey,
 ADD CONSTRAINT kb_work_receipts_page_id_fkey FOREIGN KEY(page_id) REFERENCES public.kb_pages(id) ON DELETE CASCADE;
ALTER TABLE public.kb_work_events DROP CONSTRAINT IF EXISTS kb_work_events_page_id_fkey,
 ADD CONSTRAINT kb_work_events_page_id_fkey FOREIGN KEY(page_id) REFERENCES public.kb_pages(id) ON DELETE CASCADE;
ALTER TABLE public.kb_source_links DROP CONSTRAINT IF EXISTS kb_source_links_page_id_fkey,
 ADD CONSTRAINT kb_source_links_page_id_fkey FOREIGN KEY(page_id) REFERENCES public.kb_pages(id) ON DELETE CASCADE;
ALTER TABLE public.kb_source_links DROP CONSTRAINT IF EXISTS kb_source_links_source_id_source_page_version_fkey,
 ADD CONSTRAINT kb_source_links_source_id_source_page_version_fkey FOREIGN KEY(source_id,source_page_version)
  REFERENCES public.kb_revisions(page_id,version) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.kb_publications DROP CONSTRAINT IF EXISTS kb_publications_page_id_fkey,
 ADD CONSTRAINT kb_publications_page_id_fkey FOREIGN KEY(page_id) REFERENCES public.kb_pages(id) ON DELETE CASCADE;
ALTER TABLE public.kb_publications DROP CONSTRAINT IF EXISTS kb_publications_page_id_page_version_fkey,
 ADD CONSTRAINT kb_publications_page_id_page_version_fkey FOREIGN KEY(page_id,page_version)
  REFERENCES public.kb_revisions(page_id,version) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.kb_publications DROP CONSTRAINT IF EXISTS kb_publications_predecessor_id_fkey,
 ADD CONSTRAINT kb_publications_predecessor_id_fkey FOREIGN KEY(predecessor_id)
  REFERENCES public.kb_publications(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.kb_publications DROP CONSTRAINT IF EXISTS kb_publications_successor_id_fkey,
 ADD CONSTRAINT kb_publications_successor_id_fkey FOREIGN KEY(successor_id)
  REFERENCES public.kb_publications(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

-- Source links in other pages that point at a deleted page or attachment.
-- SECURITY DEFINER: members never write kb_source_links directly.
CREATE OR REPLACE FUNCTION public.kb_work_forget_deleted_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF TG_TABLE_NAME='kb_pages' THEN
  DELETE FROM public.kb_source_links WHERE source_kind='knowledge' AND source_id=OLD.id;
 ELSE
  DELETE FROM public.kb_source_links WHERE source_kind='knowledge_file' AND source_id=OLD.id;
 END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.kb_work_forget_deleted_source() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS kb_work_forget_deleted_source ON public.kb_pages;
CREATE TRIGGER kb_work_forget_deleted_source BEFORE DELETE ON public.kb_pages FOR EACH ROW EXECUTE FUNCTION public.kb_work_forget_deleted_source();
DROP TRIGGER IF EXISTS kb_work_forget_deleted_source ON public.kb_attachments;
CREATE TRIGGER kb_work_forget_deleted_source AFTER DELETE ON public.kb_attachments FOR EACH ROW EXECUTE FUNCTION public.kb_work_forget_deleted_source();
