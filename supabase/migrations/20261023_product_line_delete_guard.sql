-- A product line cannot be deleted while it still has projects (archived ones included).
--
-- projects.line_id references product_lines ON DELETE CASCADE, so deleting a line deleted its
-- projects and every task in them. The app checks for projects first, but only among the
-- projects the caller can see; the database now refuses as well. The trigger runs as its
-- owner so it sees every project.
--
-- Repeatable: CREATE OR REPLACE, DROP TRIGGER IF EXISTS before CREATE; no row is changed.
CREATE OR REPLACE FUNCTION public.livo_product_line_delete_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.projects p WHERE p.line_id = OLD.id) THEN
    RAISE EXCEPTION 'product_line_has_projects' USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_product_line_delete_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS livo_product_line_delete_guard ON public.product_lines;
CREATE TRIGGER livo_product_line_delete_guard BEFORE DELETE ON public.product_lines
  FOR EACH ROW EXECUTE FUNCTION public.livo_product_line_delete_guard();
