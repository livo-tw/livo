ALTER TABLE kb_pages ADD COLUMN private_draft_owner_id TEXT;
ALTER TABLE kb_pages ADD COLUMN document_metadata TEXT NOT NULL DEFAULT '{"documentKind":null,"ownerId":null,"applicability":{"productVersion":null,"environment":null,"summary":null}}';
ALTER TABLE kb_revisions ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE kb_revisions ADD COLUMN document_metadata TEXT NOT NULL DEFAULT '{"documentKind":null,"ownerId":null,"applicability":{"productVersion":null,"environment":null,"summary":null}}';
