ALTER TABLE activity_results
  ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_activity_results_lesson_group
  ON activity_results (lesson_id, group_id, created_at DESC);
