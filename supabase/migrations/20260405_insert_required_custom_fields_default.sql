-- Insert default required_custom_fields setting to prevent 406 error
INSERT INTO system_settings (key, value)
VALUES ('required_custom_fields', '[]'::jsonb)
ON CONFLICT (key) DO NOTHING;
