import { Pool } from 'pg';

let pool: Pool | null = null;

export function getTestPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
  }
  return pool;
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function truncateAll(): Promise<void> {
  const p = getTestPool();
  await p.query(`
    TRUNCATE activity_results, lesson_activities, lesson_sessions, live_sessions,
             session_participants, lessons, group_students, students, group_courses,
             course_groups, courses, groups, users
    RESTART IDENTITY CASCADE
  `);
}

export async function createTestUser(opts: { role?: string } = {}): Promise<{ id: string; email: string }> {
  // NB. `users` table only accepts roles 'teacher' or 'admin' (CHECK constraint).
  // For student-flavoured ids in result tests we don't need real auth — we just
  // need any UUID, so we still create a 'teacher' row but treat the returned id
  // as the actor (works for activity_results.student_id which is just UUID).
  const p = getTestPool();
  const email = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const role = (opts.role === 'student' || opts.role === 'teacher' || opts.role === 'admin')
    ? (opts.role === 'student' ? 'teacher' : opts.role)
    : 'teacher';
  const r = await p.query(
    `INSERT INTO users (email, role, display_name)
     VALUES ($1, $2, $3) RETURNING id, email`,
    [email, role, 'Test User']
  );
  return r.rows[0];
}

export async function createTestGroup(teacherId: string): Promise<{ id: number }> {
  const p = getTestPool();
  const r = await p.query(
    `INSERT INTO groups (name, teacher_id) VALUES ($1, $2) RETURNING id`,
    ['Test Group', teacherId]
  );
  return r.rows[0];
}

export async function createTestLesson(opts: {
  groupId?: number;
  islandId?: number;
  title?: string;
} = {}): Promise<{ id: string }> {
  const p = getTestPool();
  const r = await p.query(
    `INSERT INTO lessons (title, island_id, group_id, order_index)
     VALUES ($1, $2, $3, 0) RETURNING id`,
    [opts.title || 'Test Lesson', opts.islandId || 1, opts.groupId || null]
  );
  return r.rows[0];
}

export async function createTestActivity(lessonId: string, type: string = 'image'): Promise<{ id: string }> {
  const p = getTestPool();
  const r = await p.query(
    `INSERT INTO lesson_activities (lesson_id, type, title, order_index, points)
     VALUES ($1, $2, $3, 0, 10) RETURNING id`,
    [lessonId, type, `${type} test activity`]
  );
  return r.rows[0];
}
