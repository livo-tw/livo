
-- Same atomic formal verification contract as the self-host commit RPC.
DROP TRIGGER IF EXISTS qa_verification_auto_close_guard;
CREATE TRIGGER qa_verification_auto_close_guard BEFORE INSERT ON qa_commands
WHEN NEW.operation='record_verification' AND NEW.restored_by IS NULL BEGIN
 SELECT RAISE(ABORT,'qa_invalid_request') WHERE NOT EXISTS(SELECT 1 FROM qa_issues q
   WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND q.state IN ('verification','verified')
   AND json_remove(NEW.issue_data,'$.runs','$.state','$.resolution','$.resolutionReason','$.duplicateOfId','$.closedAt','$.closedBy','$.reopenedAt','$.version','$.updatedAt')
     =json_remove(q.data,'$.runs','$.state','$.resolution','$.resolutionReason','$.duplicateOfId','$.closedAt','$.closedBy','$.reopenedAt','$.version','$.updatedAt')
   AND json_type(NEW.issue_data,'$.runs')='array' AND json_array_length(NEW.issue_data,'$.runs')=json_array_length(q.data,'$.runs')+1
   AND NOT EXISTS(SELECT 1 FROM json_each(q.data,'$.runs') old
     WHERE old.value IS NOT json_extract(NEW.issue_data,'$.runs['||old.key||']')));
 SELECT RAISE(ABORT,'qa_not_deployed') WHERE NOT EXISTS(SELECT 1 FROM qa_issues q,json_each(q.data,'$.targets') t
   WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id
   AND json_extract(t.value,'$.id')=json_extract(NEW.issue_data,'$.runs[#-1].targetId')
   AND json_type(t.value,'$.deployedAt')='text' AND length(json_extract(t.value,'$.deployedAt'))>0);
 SELECT RAISE(ABORT,'qa_invalid_request') WHERE NOT EXISTS(SELECT 1 FROM qa_issues q,json_each(q.data,'$.targets') t
   WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id
   AND json_extract(t.value,'$.id')=json_extract(NEW.issue_data,'$.runs[#-1].targetId')
   AND json_extract(NEW.issue_data,'$.runs[#-1].fixCycle') IS json_extract(q.data,'$.fixCycle')
   AND json_extract(NEW.issue_data,'$.runs[#-1].build') IS json_extract(t.value,'$.build')
   AND json_extract(NEW.issue_data,'$.runs[#-1].environment') IS json_extract(t.value,'$.environment')
   AND json_extract(NEW.issue_data,'$.runs[#-1].component') IS json_extract(t.value,'$.component')
   AND json_extract(NEW.issue_data,'$.runs[#-1].testerId') IS NEW.actor_id
   AND json_extract(NEW.issue_data,'$.runs[#-1].createdAt') IS json_extract(NEW.issue_data,'$.updatedAt')
   AND json_extract(NEW.issue_data,'$.runs[#-1].result') IN ('pass','fail','blocked')
   AND json_type(NEW.issue_data,'$.runs[#-1].id')='text' AND length(json_extract(NEW.issue_data,'$.runs[#-1].id')) BETWEEN 1 AND 100
   AND json_type(NEW.issue_data,'$.runs[#-1].note')='text' AND length(json_extract(NEW.issue_data,'$.runs[#-1].note'))<=8000
   AND json_extract(NEW.issue_data,'$.runs[#-1].sequence')=(SELECT COALESCE(max(json_extract(v.value,'$.sequence')),0)+1 FROM json_each(q.data,'$.runs') v));
 SELECT RAISE(ABORT,'qa_invalid_request') WHERE json_extract(NEW.issue_data,'$.state') IS NOT
   CASE WHEN json_extract(NEW.issue_data,'$.runs[#-1].result')='fail' THEN 'failed'
     WHEN EXISTS(SELECT 1 FROM json_each(NEW.issue_data,'$.targets') t WHERE json_extract(t.value,'$.required')=1)
       AND NOT EXISTS(SELECT 1 FROM json_each(NEW.issue_data,'$.targets') t WHERE json_extract(t.value,'$.required')=1 AND
         (json_type(t.value,'$.deployedAt') IS NOT 'text' OR length(json_extract(t.value,'$.deployedAt'))=0 OR
           (SELECT json_extract(v.value,'$.result') FROM json_each(NEW.issue_data,'$.runs') v
             WHERE json_extract(v.value,'$.fixCycle')=json_extract(NEW.issue_data,'$.fixCycle') AND json_extract(v.value,'$.targetId')=json_extract(t.value,'$.id')
             ORDER BY json_extract(v.value,'$.sequence') DESC LIMIT 1) IS NOT 'pass' OR
           (SELECT json_extract(v.value,'$.build') FROM json_each(NEW.issue_data,'$.runs') v
             WHERE json_extract(v.value,'$.fixCycle')=json_extract(NEW.issue_data,'$.fixCycle') AND json_extract(v.value,'$.targetId')=json_extract(t.value,'$.id')
             ORDER BY json_extract(v.value,'$.sequence') DESC LIMIT 1) IS NOT json_extract(t.value,'$.build')))
       THEN CASE WHEN json_extract(NEW.issue_data,'$.runs[#-1].result')='pass' THEN 'closed' ELSE 'verified' END ELSE 'verification' END;
 SELECT RAISE(ABORT,'qa_invalid_request') WHERE json_extract(NEW.issue_data,'$.state')='closed' AND
   (json_extract(NEW.issue_data,'$.resolution') IS NOT 'fixed' OR json_extract(NEW.issue_data,'$.resolutionReason') IS NOT ''
     OR json_type(NEW.issue_data,'$.duplicateOfId') IS NOT 'null' OR json_extract(NEW.issue_data,'$.closedAt') IS NOT json_extract(NEW.issue_data,'$.updatedAt')
     OR json_extract(NEW.issue_data,'$.closedBy') IS NOT NEW.actor_id
     OR json_extract(NEW.issue_data,'$.reopenedAt') IS NOT (SELECT json_extract(data,'$.reopenedAt') FROM qa_issues WHERE workspace_id=NEW.workspace_id AND id=NEW.issue_id));
 SELECT RAISE(ABORT,'qa_invalid_request') WHERE json_extract(NEW.issue_data,'$.state')<>'closed' AND EXISTS(SELECT 1 FROM qa_issues q
   WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND
   (json_remove(NEW.issue_data,'$.runs','$.state','$.reopenedAt','$.version','$.updatedAt') IS NOT json_remove(q.data,'$.runs','$.state','$.reopenedAt','$.version','$.updatedAt')
     OR (json_extract(NEW.issue_data,'$.runs[#-1].result')='fail' AND json_extract(NEW.issue_data,'$.reopenedAt') IS NOT json_extract(NEW.issue_data,'$.updatedAt'))
     OR (json_extract(NEW.issue_data,'$.runs[#-1].result')<>'fail' AND json_extract(NEW.issue_data,'$.reopenedAt') IS NOT json_extract(q.data,'$.reopenedAt'))));
END;
