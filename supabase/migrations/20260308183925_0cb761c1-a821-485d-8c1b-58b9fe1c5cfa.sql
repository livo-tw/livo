INSERT INTO storage.buckets (id, name, public) VALUES ('task-images', 'task-images', true) ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Anyone can read task images" ON storage.objects FOR SELECT USING (bucket_id = 'task-images');
CREATE POLICY "Anyone can upload task images" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'task-images');
CREATE POLICY "Anyone can delete task images" ON storage.objects FOR DELETE USING (bucket_id = 'task-images');