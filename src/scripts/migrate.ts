import { pgPool } from '../config/database';
import logger from '../utils/logger';
import dotenv from 'dotenv';

dotenv.config();

const migrations = [
  // Users table
  `
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    session_code CHAR(6) UNIQUE,
    role VARCHAR(10) CHECK (role IN ('teacher', 'student')),
    display_name VARCHAR(50) NOT NULL,
    avatar_color VARCHAR(7) NOT NULL,
    current_session_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_session_code ON users(session_code);
  CREATE INDEX IF NOT EXISTS idx_current_session ON users(current_session_id);
  `,

  // Sessions table
  `
  CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY,
    teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    island_id INTEGER NOT NULL,
    current_activity VARCHAR(50),
    mode VARCHAR(20) DEFAULT 'synchronized' CHECK (mode IN ('synchronized', 'guided', 'independent')),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
    expires_at TIMESTAMPTZ NOT NULL,
    settings JSONB DEFAULT '{"allowSelfPacing": false, "autoAdvance": false}',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_teacher_active ON sessions(teacher_id, status);
  CREATE INDEX IF NOT EXISTS idx_expires ON sessions(expires_at);
  `,

  // Student progress table
  `
  CREATE TABLE IF NOT EXISTS student_progress (
    id UUID PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    activity_id VARCHAR(50) NOT NULL,
    score INTEGER DEFAULT 0,
    data JSONB,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_student_session ON student_progress(student_id, session_id);
  CREATE INDEX IF NOT EXISTS idx_session_activity ON student_progress(session_id, activity_id);
  `,

  // Media files table (optional, for future use)
  `
  CREATE TABLE IF NOT EXISTS media_files (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(10) CHECK (type IN ('audio', 'video', 'image')),
    storage_url VARCHAR(500) NOT NULL,
    thumbnail_url VARCHAR(500),
    duration INTEGER,
    size INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_user_media ON media_files(user_id, type, created_at);
  `,
];

async function runMigrations() {
  try {
    logger.info('Starting database migrations...');

    for (let i = 0; i < migrations.length; i++) {
      logger.info(`Running migration ${i + 1}/${migrations.length}`);
      await pgPool.query(migrations[i]);
    }

    logger.info('✅ All migrations completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigrations();
