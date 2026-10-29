-- Deliberately minimal typed dependencies for the *released* Jira clear bodies.
-- The runner extracts those bodies/rename blocks from their shipped migrations;
-- this is not a replacement for the complete official schema/HTTP installation.
-- Only columns referenced by those bodies, with their real released types.
-- QA/release aggregate fields and KB page/revision foreign keys are out of scope.
CREATE TABLE public.qa_issues(id text PRIMARY KEY,data jsonb NOT NULL);
CREATE TABLE public.release_batches(id text PRIMARY KEY);
CREATE TABLE public.kb_work_clock(id integer PRIMARY KEY CHECK(id=1),generation bigint NOT NULL DEFAULT 0);
INSERT INTO public.kb_work_clock(id) VALUES(1);
CREATE TABLE public.kb_source_links(id text PRIMARY KEY,source_kind text NOT NULL CHECK(source_kind IN('knowledge','task','qa','knowledge_file','task_file','qa_file')));
GRANT ALL ON public.qa_issues,public.release_batches,public.kb_work_clock,public.kb_source_links TO service_role;
