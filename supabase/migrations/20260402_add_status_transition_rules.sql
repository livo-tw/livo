CREATE TABLE status_transition_rules (
  id text PRIMARY KEY DEFAULT ('str_' || substr(md5(random()::text), 1, 12)),
  target_status_id text NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
  required_status_id text NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(target_status_id, required_status_id)
);

ALTER TABLE status_transition_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON status_transition_rules FOR ALL USING (true) WITH CHECK (true);
