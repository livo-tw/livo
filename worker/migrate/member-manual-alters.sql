-- The runner probes this column before applying; existing answers are untouched.
ALTER TABLE member_manuals ADD COLUMN custom_fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(custom_fields) AND json_type(custom_fields) = 'object');
