-- Create sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lesson_id UUID REFERENCES lessons(id) ON DELETE CASCADE,
    activity_index INTEGER NOT NULL,
    teacher_id UUID NOT NULL,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'waiting', -- waiting, active, completed
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create session_participants table
CREATE TABLE IF NOT EXISTS session_participants (
    id SERIAL PRIMARY KEY,
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES group_students(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'connected', -- connected, in_progress, completed
    answers JSONB, -- Store student's answers
    score INTEGER DEFAULT 0,
    completed_at TIMESTAMP WITH TIME ZONE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(session_id, student_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_sessions_lesson_id ON sessions(lesson_id);
CREATE INDEX IF NOT EXISTS idx_sessions_teacher_id ON sessions(teacher_id);
CREATE INDEX IF NOT EXISTS idx_sessions_group_id ON sessions(group_id);
CREATE INDEX IF NOT EXISTS idx_session_participants_session_id ON session_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_session_participants_student_id ON session_participants(student_id);
