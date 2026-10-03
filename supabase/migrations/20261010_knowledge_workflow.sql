-- Page-local maintenance checklists, immutable sources and private work backlinks.
CREATE TABLE IF NOT EXISTS public.kb_source_snapshots (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, workspace_id text NOT NULL DEFAULT 'default' CHECK(workspace_id='default'),
  page_id text NOT NULL REFERENCES public.kb_pages(id) ON DELETE CASCADE, source_kind text NOT NULL, source_title text NOT NULL,
  source_url text, source_key text, source_version text, body text NOT NULL CHECK(length(body)<=1000000),
  body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'), page_version integer NOT NULL CHECK(page_version>0),
  provenance jsonb NOT NULL DEFAULT '{}', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kb_snapshot_identity ON public.kb_source_snapshots(workspace_id,page_id,body_hash,source_kind,COALESCE(source_key,''));
CREATE INDEX IF NOT EXISTS kb_snapshot_page ON public.kb_source_snapshots(page_id,created_at);
CREATE OR REPLACE FUNCTION public.kb_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN RAISE EXCEPTION 'kb_workflow_immutable' USING ERRCODE='42501'; END; $$;
DROP TRIGGER IF EXISTS kb_snapshot_immutable ON public.kb_source_snapshots;
CREATE TRIGGER kb_snapshot_immutable BEFORE UPDATE ON public.kb_source_snapshots FOR EACH ROW EXECUTE FUNCTION public.kb_snapshot_immutable();
CREATE TABLE IF NOT EXISTS public.kb_checklist_items (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, workspace_id text NOT NULL DEFAULT 'default' CHECK(workspace_id='default'),
  page_id text NOT NULL REFERENCES public.kb_pages(id) ON DELETE CASCADE, anchor_id text NOT NULL,
  text text NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 2000), is_done boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  completed_by text, completed_at timestamptz, UNIQUE(page_id,anchor_id)
);
CREATE TABLE IF NOT EXISTS public.kb_work_links (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, workspace_id text NOT NULL DEFAULT 'default' CHECK(workspace_id='default'),
  page_id text NOT NULL REFERENCES public.kb_pages(id) ON DELETE CASCADE, anchor_id text NOT NULL,
  checklist_id text REFERENCES public.kb_checklist_items(id) ON DELETE RESTRICT, snapshot_id text REFERENCES public.kb_source_snapshots(id) ON DELETE RESTRICT,
  target_kind text NOT NULL CHECK(target_kind IN('task','qa')), target_id text NOT NULL,
  relation text NOT NULL CHECK(relation IN('reference','meeting','decision','verification')), created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(page_id,anchor_id,target_kind,target_id), UNIQUE(checklist_id)
);
CREATE INDEX IF NOT EXISTS kb_link_page ON public.kb_work_links(page_id);
CREATE INDEX IF NOT EXISTS kb_link_target ON public.kb_work_links(target_kind,target_id);
CREATE TABLE IF NOT EXISTS public.kb_workflow_commands (
  workspace_id text NOT NULL DEFAULT 'default' CHECK(workspace_id='default'), id text PRIMARY KEY, actor_id text NOT NULL, page_id text NOT NULL,
  request_hash text NOT NULL, result_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.kb_source_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_work_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_workflow_commands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kb_snapshot_read ON public.kb_source_snapshots;
CREATE POLICY kb_snapshot_read ON public.kb_source_snapshots FOR SELECT TO authenticated USING(public.kb_has_permission(page_id,'view'));
DROP POLICY IF EXISTS kb_checklist_read ON public.kb_checklist_items;
CREATE POLICY kb_checklist_read ON public.kb_checklist_items FOR SELECT TO authenticated USING(public.kb_has_permission(page_id,'view'));
DROP POLICY IF EXISTS kb_link_read ON public.kb_work_links;
CREATE POLICY kb_link_read ON public.kb_work_links FOR SELECT TO authenticated USING(public.kb_has_permission(page_id,'view'));
REVOKE ALL ON public.kb_source_snapshots,public.kb_checklist_items,public.kb_work_links,public.kb_workflow_commands FROM anon,authenticated;
GRANT SELECT ON public.kb_source_snapshots,public.kb_checklist_items TO authenticated;
GRANT ALL ON public.kb_source_snapshots,public.kb_checklist_items,public.kb_work_links,public.kb_workflow_commands TO service_role;

-- Serialize new keys without renumbering or deleting legacy duplicates.
CREATE OR REPLACE FUNCTION public.kb_task_key_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.task_key IS NOT DISTINCT FROM OLD.task_key THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('task-key:'||NEW.task_key));
  IF EXISTS(SELECT 1 FROM public.tasks WHERE task_key=NEW.task_key AND id<>NEW.id) THEN RAISE EXCEPTION 'kb_workflow_task_key_conflict' USING ERRCODE='23505'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS kb_task_key_guard ON public.tasks;
CREATE TRIGGER kb_task_key_guard BEFORE INSERT OR UPDATE OF task_key ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.kb_task_key_guard();

CREATE OR REPLACE FUNCTION public.kb_workflow(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
#variable_conflict use_variable
DECLARE actor text:=public.current_member_id(); action text:=p_request->>'action'; page_id text:=p_request->>'pageId';
  page public.kb_pages%ROWTYPE; checklist public.kb_checklist_items%ROWTYPE; receipt public.kb_workflow_commands%ROWTYPE;
  item_id text:=gen_random_uuid()::text; anchor_id text:=COALESCE(NULLIF(p_request->>'anchorId',''),gen_random_uuid()::text);
  checklist_id text:=NULLIF(p_request->>'checklistId',''); snapshot_id text:=NULLIF(p_request->>'snapshotId','');
  target_kind text:=p_request->>'targetKind'; target_id text:=p_request->>'targetId'; relation text:=COALESCE(p_request->>'relation','reference');
  command_id text:=p_request->>'commandId'; request_hash text; answer jsonb; input jsonb:=p_request->'input'; result_id text;
  moment timestamptz:=clock_timestamp(); title text; project_id text; status_id text; assignee text; due text; description text;
  project_key text; task_key text; next_number bigint; qa_data jsonb; req_fields jsonb; setting record; hash text;
BEGIN
  IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.members WHERE id=actor AND auth_id=auth.uid() AND is_active) THEN RAISE EXCEPTION 'kb_workflow_forbidden' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_request)<>'object' OR length(p_request::text)>262144 THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
  IF action='backlinks' THEN
    IF target_kind NOT IN('task','qa') THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
    IF (target_kind='task' AND NOT EXISTS(SELECT 1 FROM public.tasks WHERE id=target_id)) OR
      (target_kind='qa' AND (NOT public.livo_qa_enabled() OR NOT EXISTS(SELECT 1 FROM public.qa_issues WHERE workspace_id='default' AND id=target_id))) THEN RETURN jsonb_build_object('items','[]'::jsonb); END IF;
    SELECT COALESCE(jsonb_agg(row_to_json(r)),'[]') INTO answer FROM(SELECT l.id AS "linkId",p.id AS "pageId",p.title,p.category,l.anchor_id AS "anchorId",l.relation
      FROM public.kb_work_links l JOIN public.kb_pages p ON p.id=l.page_id WHERE l.target_kind=target_kind AND l.target_id=target_id AND public.kb_has_permission(p.id,'view') ORDER BY p.title,l.id LIMIT 200) r;
    RETURN jsonb_build_object('items',answer);
  END IF;
  SELECT * INTO page FROM public.kb_pages p WHERE p.id=page_id AND public.kb_has_permission(p.id,'view');
  IF NOT FOUND THEN RAISE EXCEPTION 'kb_workflow_unavailable' USING ERRCODE='P0002'; END IF;
  IF action='list' THEN
    RETURN jsonb_build_object('pageVersion',page.version,
      'checklist',(SELECT COALESCE(jsonb_agg(row_to_json(r)),'[]') FROM(SELECT c.id,c.page_id AS "pageId",c.anchor_id AS "anchorId",c.text,c.is_done AS "isDone",c.version,
        c.updated_by AS "updatedBy",c.updated_at AS "updatedAt",c.completed_by AS "completedBy",c.completed_at AS "completedAt",l.id AS "linkedWorkId"
        FROM public.kb_checklist_items c LEFT JOIN public.kb_work_links l ON l.checklist_id=c.id WHERE c.page_id=page_id AND public.kb_has_permission(c.page_id,'view') ORDER BY c.created_at,c.id LIMIT 500) r),
      'links',(SELECT COALESCE(jsonb_agg(row_to_json(r)),'[]') FROM(SELECT l.id,l.page_id AS "pageId",l.anchor_id AS "anchorId",l.checklist_id AS "checklistId",l.snapshot_id AS "snapshotId",
        l.target_kind AS "targetKind",l.target_id AS "targetId",l.relation,
        COALESCE(CASE WHEN l.target_kind='task' THEN t.title ELSE q.title END,'') AS title,COALESCE(CASE WHEN l.target_kind='task' THEN t.task_key ELSE q.id END,'') AS key,
        COALESCE(CASE WHEN l.target_kind='task' THEN s.name ELSE q.state END,'') AS status,CASE WHEN l.target_kind='task' THEN t.assignee_id ELSE q.assignee_id END AS "assigneeId",
        CASE WHEN l.target_kind='task' THEN t.due_date ELSE q.data->>'dueDate' END AS "dueDate",CASE WHEN l.target_kind='task' THEN t.id IS NULL ELSE q.id IS NULL END AS unavailable
        FROM public.kb_work_links l LEFT JOIN public.tasks t ON l.target_kind='task' AND t.id=l.target_id LEFT JOIN public.statuses s ON s.id=t.status_id
        LEFT JOIN public.qa_issues q ON l.target_kind='qa' AND q.id=l.target_id AND q.workspace_id='default' AND public.livo_qa_enabled()
        WHERE l.page_id=page_id AND public.kb_has_permission(l.page_id,'view') ORDER BY l.created_at,l.id LIMIT 500) r),
      'snapshots',(SELECT COALESCE(jsonb_agg(row_to_json(r)),'[]') FROM(SELECT s.id,s.page_id AS "pageId",s.source_kind AS "sourceKind",s.source_title AS "sourceTitle",s.source_url AS "sourceUrl",
        s.body_hash AS "bodyHash",s.page_version AS "pageVersion",s.created_at AS "createdAt" FROM public.kb_source_snapshots s WHERE s.page_id=page_id AND public.kb_has_permission(s.page_id,'view') ORDER BY s.created_at DESC,s.id LIMIT 200) r));
  END IF;
  IF action='snapshot' THEN
    SELECT row_to_json(r)::jsonb INTO answer FROM(SELECT s.id,s.page_id AS "pageId",s.source_kind AS "sourceKind",s.source_title AS "sourceTitle",s.source_url AS "sourceUrl",s.body_hash AS "bodyHash",
      s.page_version AS "pageVersion",s.created_at AS "createdAt",s.body,s.provenance FROM public.kb_source_snapshots s WHERE s.page_id=page_id AND s.id=p_request->>'snapshotId' AND public.kb_has_permission(s.page_id,'view')) r;
    IF answer IS NULL THEN RAISE EXCEPTION 'kb_workflow_unavailable' USING ERRCODE='P0002'; END IF; RETURN answer;
  END IF;
  IF NOT public.kb_has_permission(page_id,'edit') THEN RAISE EXCEPTION 'kb_workflow_forbidden' USING ERRCODE='42501'; END IF;
  IF action='search_targets' THEN
    IF target_kind NOT IN('task','qa') OR length(COALESCE(p_request->>'query',''))>200 THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
    IF target_kind='task' THEN SELECT COALESCE(jsonb_agg(row_to_json(r)),'[]') INTO answer FROM(SELECT t.id,t.title,t.task_key AS key,t.project_id AS "projectId" FROM public.tasks t
      WHERE position(lower(COALESCE(p_request->>'query','')) in lower(t.title||' '||t.task_key))>0 ORDER BY t.title,t.id LIMIT 50) r;
    ELSE SELECT COALESCE(jsonb_agg(row_to_json(r)),'[]') INTO answer FROM(SELECT q.id,q.title,q.id AS key,q.project_id AS "projectId" FROM public.qa_issues q
      WHERE q.workspace_id='default' AND public.livo_qa_enabled() AND position(lower(COALESCE(p_request->>'query','')) in lower(q.title||' '||q.id))>0 ORDER BY q.title,q.id LIMIT 50) r; END IF;
    RETURN jsonb_build_object('items',answer);
  END IF;
  IF action NOT IN('checklist_add','checklist_set','checklist_delete','link','unlink','create_task','create_qa','capture_snapshot')
    OR command_id !~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$' OR command_id IS NULL THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
  request_hash:=encode(extensions.digest(p_request::text,'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtext('kb-workflow:'||command_id));
  SELECT * INTO receipt FROM public.kb_workflow_commands WHERE id=command_id;
  IF FOUND THEN
    IF receipt.actor_id<>actor OR receipt.page_id<>page_id OR receipt.request_hash<>request_hash THEN RAISE EXCEPTION 'kb_workflow_idempotency_conflict' USING ERRCODE='23505'; END IF;
    RETURN receipt.result_json;
  END IF;
  -- Lock page and ancestors: ACL edits/reparenting cannot race the transaction.
  PERFORM p.id FROM public.kb_pages p WHERE p.id IN(WITH RECURSIVE ancestors AS(SELECT p0.id,p0.parent_id FROM public.kb_pages p0 WHERE p0.id=page_id UNION ALL SELECT p1.id,p1.parent_id FROM public.kb_pages p1 JOIN ancestors a ON p1.id=a.parent_id) SELECT id FROM ancestors) ORDER BY p.id FOR SHARE;
  PERFORM m.id FROM public.members m WHERE m.id=actor FOR SHARE;
  IF NOT public.kb_has_permission(page_id,'edit') THEN RAISE EXCEPTION 'kb_workflow_forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO page FROM public.kb_pages WHERE id=page_id;
  IF p_request ? 'expectedPageVersion' AND page.version<>(p_request->>'expectedPageVersion')::integer THEN RAISE EXCEPTION 'kb_workflow_conflict' USING ERRCODE='40001'; END IF;
  IF checklist_id IS NOT NULL THEN
    SELECT * INTO checklist FROM public.kb_checklist_items c WHERE c.id=checklist_id AND c.page_id=page_id FOR UPDATE;
    IF NOT FOUND OR checklist.version IS DISTINCT FROM (p_request->>'expectedVersion')::integer OR EXISTS(SELECT 1 FROM public.kb_work_links l WHERE l.checklist_id=checklist_id) THEN RAISE EXCEPTION 'kb_workflow_conflict' USING ERRCODE='40001'; END IF;
    anchor_id:=checklist.anchor_id;
  END IF;
  IF snapshot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.kb_source_snapshots s WHERE s.id=snapshot_id AND s.page_id=page_id) THEN RAISE EXCEPTION 'kb_workflow_unavailable' USING ERRCODE='P0002'; END IF;
  IF action='checklist_add' THEN
    IF length(trim(COALESCE(p_request->>'text',''))) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
    INSERT INTO public.kb_checklist_items(id,page_id,anchor_id,text,created_by,updated_by) VALUES(item_id,page_id,anchor_id,trim(p_request->>'text'),actor,actor);
  ELSIF action IN('checklist_set','checklist_delete') THEN
    IF checklist_id IS NULL THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
    item_id:=checklist_id;
    IF action='checklist_delete' THEN DELETE FROM public.kb_checklist_items c WHERE c.id=checklist_id AND c.page_id=page_id;
    ELSE
      IF jsonb_typeof(p_request->'isDone') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
      UPDATE public.kb_checklist_items c SET is_done=(p_request->>'isDone')::boolean,version=c.version+1,updated_by=actor,updated_at=moment,
        completed_by=CASE WHEN (p_request->>'isDone')::boolean THEN actor ELSE NULL END,completed_at=CASE WHEN (p_request->>'isDone')::boolean THEN moment ELSE NULL END WHERE c.id=checklist_id AND c.page_id=page_id;
    END IF;
  ELSIF action='unlink' THEN
    DELETE FROM public.kb_work_links l WHERE l.id=p_request->>'linkId' AND l.page_id=page_id RETURNING id INTO item_id;
    IF item_id IS NULL THEN RAISE EXCEPTION 'kb_workflow_unavailable' USING ERRCODE='P0002'; END IF;
  ELSIF action='capture_snapshot' THEN
    IF NOT p_request ? 'expectedPageVersion' THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
    hash:=encode(extensions.digest(page.body,'sha256'),'hex');
    SELECT s.id INTO result_id FROM public.kb_source_snapshots s WHERE s.page_id=page_id AND s.body_hash=hash AND s.source_kind='page' AND s.source_key=page_id;
    IF result_id IS NULL THEN INSERT INTO public.kb_source_snapshots(id,page_id,source_kind,source_title,source_key,body,body_hash,page_version,created_by) VALUES(item_id,page_id,'page',page.title,page_id,page.body,hash,page.version,actor);
    ELSE item_id:=result_id; END IF;
  ELSE
    IF relation NOT IN('reference','meeting','decision','verification') THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
    IF action IN('create_task','create_qa') THEN
      IF NOT p_request ? 'expectedPageVersion' OR jsonb_typeof(input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
      project_id:=input->>'projectId'; title:=trim(input->>'title'); target_id:=gen_random_uuid()::text;
      SELECT p.key INTO project_key FROM public.projects p WHERE p.id=project_id AND NOT p.is_archived FOR UPDATE;
      IF project_key IS NULL OR length(COALESCE(title,'')) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
      IF snapshot_id IS NULL THEN
        hash:=encode(extensions.digest(page.body,'sha256'),'hex');
        SELECT s.id INTO snapshot_id FROM public.kb_source_snapshots s WHERE s.page_id=page_id AND s.body_hash=hash AND s.source_kind='page' AND s.source_key=page_id;
        IF snapshot_id IS NULL THEN
          snapshot_id:=gen_random_uuid()::text;
          INSERT INTO public.kb_source_snapshots(id,page_id,source_kind,source_title,source_key,body,body_hash,page_version,created_by) VALUES(snapshot_id,page_id,'page',page.title,page_id,page.body,hash,page.version,actor);
        END IF;
      END IF;
      IF action='create_task' THEN
        target_kind:='task'; status_id:=input->>'statusId'; assignee:=NULLIF(input->>'assigneeId',''); due:=NULLIF(input->>'dueDate','');
        IF NOT EXISTS(SELECT 1 FROM public.statuses s WHERE s.id=status_id AND NOT s.is_done) OR (assignee IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.members m WHERE m.id=assignee AND m.is_active)) THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
        IF due IS NOT NULL AND (due !~ '^\d{4}-\d{2}-\d{2}$' OR to_char(due::date,'YYYY-MM-DD')<>due) THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
        IF length(COALESCE(input->>'description',''))>20000 THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
        description:=replace(replace(replace(trim(COALESCE(input->>'description','')),'&','&amp;'),'<','&lt;'),'>','&gt;');
        IF description<>'' THEN description:='<p>'||replace(description,E'\n','<br>')||'</p>'; END IF;
        SELECT value INTO req_fields FROM public.system_settings WHERE key='required_fields' FOR SHARE;
        FOR setting IN SELECT key,value FROM jsonb_each(COALESCE(req_fields,'{}')) LOOP
          IF setting.value='true' AND setting.key NOT IN('title','project','status','priority') AND NOT COALESCE(CASE setting.key WHEN 'assignee' THEN assignee IS NOT NULL WHEN 'dueDate' THEN due IS NOT NULL WHEN 'requirement' THEN description<>'' ELSE false END,false) THEN RAISE EXCEPTION 'kb_workflow_required_fields' USING ERRCODE='22023'; END IF;
        END LOOP;
        SELECT COALESCE(MAX(CASE WHEN substring(t.task_key FROM length(project_key)+2) ~ '^\d+$' THEN substring(t.task_key FROM length(project_key)+2)::bigint ELSE 0 END),0)+1 INTO next_number FROM public.tasks t WHERE t.project_id=project_id AND left(t.task_key,length(project_key)+1)=project_key||'-';
        task_key:=project_key||'-'||next_number;
        INSERT INTO public.tasks(id,task_key,project_id,title,status_id,priority,creator_id,assignee_id,due_date) VALUES(target_id,task_key,project_id,title,status_id,'medium',actor,assignee,due);
        INSERT INTO public.task_specs(task_id,background,requirement,notes) VALUES(target_id,'',description,'');
        INSERT INTO public.activity_logs(user_id,action,target_type,task_id,detail) VALUES(actor,'create','task',target_id,'Task created');
      ELSE
        target_kind:='qa';
        IF length(trim(COALESCE(input->>'actual',''))) NOT BETWEEN 1 AND 20000 OR length(COALESCE(input->>'steps',''))>20000 OR length(COALESCE(input->>'expected',''))>20000
          OR length(COALESCE(input->>'component',''))>120 OR length(COALESCE(input->>'observedVersion',''))>200
          OR COALESCE(input->>'severity','untriaged') NOT IN('untriaged','low','medium','high') THEN RAISE EXCEPTION 'kb_workflow_invalid' USING ERRCODE='22023'; END IF;
        qa_data:=jsonb_build_object('id',target_id,'workspaceId','default','projectId',project_id,'title',title,'actual',trim(input->>'actual'),'steps',COALESCE(input->>'steps',''),'expected',COALESCE(input->>'expected',''),
          'observedEnvironment',input->>'observedEnvironment','observedVersion',COALESCE(input->>'observedVersion',''),'component',COALESCE(input->>'component',''),'reporterId',actor,'assigneeId',NULL,'qaOwnerId',NULL,
          'severity',COALESCE(input->>'severity','untriaged'),'priority',3,'dueDate',NULL,'state','new','resolution',NULL,'resolutionReason','','duplicateOfId',NULL,'fixCycle',0,'version',1,'fixSummary','','holdReason','',
          'targets','[]'::jsonb,'runs','[]'::jsonb,'taskIds','[]'::jsonb,'createdAt',moment,'updatedAt',moment,'closedAt',NULL,'reopenedAt',NULL);
        PERFORM public.livo_qa_commit(auth.uid(),target_id,'kb_'||command_id,request_hash,-1,'create',qa_data,jsonb_build_object('id',gen_random_uuid()::text,'type','create','detail','create'));
      END IF;
    ELSIF target_kind NOT IN('task','qa') OR (target_kind='task' AND NOT EXISTS(SELECT 1 FROM public.tasks t WHERE t.id=target_id)) OR
      (target_kind='qa' AND (NOT public.livo_qa_enabled() OR NOT EXISTS(SELECT 1 FROM public.qa_issues q WHERE q.id=target_id AND q.workspace_id='default'))) THEN RAISE EXCEPTION 'kb_workflow_unavailable' USING ERRCODE='P0002'; END IF;
    INSERT INTO public.kb_work_links(id,page_id,anchor_id,checklist_id,snapshot_id,target_kind,target_id,relation,created_by) VALUES(item_id,page_id,anchor_id,checklist_id,snapshot_id,target_kind,target_id,relation,actor);
  END IF;
  answer:=jsonb_build_object('id',item_id);
  IF action IN('link','create_task','create_qa') THEN answer:=answer||jsonb_build_object('targetKind',target_kind,'targetId',target_id); END IF;
  INSERT INTO public.kb_workflow_commands(id,actor_id,page_id,request_hash,result_json) VALUES(command_id,actor,page_id,request_hash,answer);
  RETURN answer;
END; $$;
REVOKE ALL ON FUNCTION public.kb_workflow(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.kb_workflow(jsonb) TO authenticated;
