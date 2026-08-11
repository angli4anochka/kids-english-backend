import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3003;

// Database connection
const poolConfig: any = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'kids_english',
  user: process.env.DB_USER || 'postgres',
};

// Only add password if it's provided
if (process.env.DB_PASSWORD) {
  poolConfig.password = process.env.DB_PASSWORD;
}

const pool = new Pool(poolConfig);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

// Rewrite direct Object Storage URLs to the CDN domain, if configured.
// Off by default (MEDIA_CDN_BASE_URL unset) вЂ” direct S3 URLs keep working
// until the CDN's SSL cert is confirmed live, so this is safe to deploy early.
const STORAGE_BASE = 'https://storage.yandexcloud.net/kids-app';
const CDN_BASE = process.env.MEDIA_CDN_BASE_URL;

function withCdnUrls<T>(row: T): T {
  if (!CDN_BASE) return row;
  const raw = JSON.stringify(row);
  if (!raw.includes(STORAGE_BASE)) return row;
  return JSON.parse(raw.split(STORAGE_BASE).join(CDN_BASE));
}

// Middleware
app.use(cors());
// Activities (esp. snake/letter games) embed images as base64 вЂ” bump body limit from default 100kb
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'kids-english-backend' });
});

// GET /lessons - Get all lessons
app.get('/lessons', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM lessons
      ORDER BY created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching lessons:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch lessons' });
  }
});

// GET /lessons/:id - Get lesson by ID
app.get('/lessons/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM lessons WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Lesson not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching lesson:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch lesson' });
  }
});

// POST /lessons - Create new lesson
app.post('/lessons', async (req, res) => {
  try {
    const { title, description, islandId, emoji, courseId, bookId, unit_number } = req.body;

    let insertOrder: number;

    if (bookId && unit_number != null) {
      // Place right after last lesson of this unit, then shift subsequent lessons down
      const unitMaxResult = await pool.query(
        'SELECT COALESCE(MAX(order_index), 0) as max FROM lessons WHERE book_id = $1 AND unit_number = $2 AND COALESCE(is_deleted, false) = false',
        [bookId, unit_number]
      );
      insertOrder = (unitMaxResult.rows[0].max || 0) + 1;
      await pool.query(
        'UPDATE lessons SET order_index = order_index + 1 WHERE book_id = $1 AND order_index >= $2 AND COALESCE(is_deleted, false) = false',
        [bookId, insertOrder]
      );
    } else {
      const maxOrderResult = await pool.query(
        "SELECT COALESCE(MAX(order_index), 0) as max FROM lessons WHERE COALESCE(book_id::text, island_id::text, 'x') = COALESCE($1::text, $2::text, 'x') AND COALESCE(is_deleted, false) = false",
        [bookId || null, islandId || null]
      );
      insertOrder = (maxOrderResult.rows[0].max || 0) + 1;
    }

    const result = await pool.query(`
      INSERT INTO lessons (title, description, island_id, emoji, status, order_index, course_id, book_id, unit_number)
      VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8)
      RETURNING *
    `, [title, description || null, islandId || null, emoji || 'рџЏќпёЏ', insertOrder, courseId || null, bookId || null, unit_number ?? null]);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error creating lesson:', error);
    res.status(500).json({ success: false, error: 'Failed to create lesson' });
  }
});

// PUT /lessons/:id - Update lesson
app.put('/lessons/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      status,
      unit_number,
      unit_name,
      order_index,
      course_id,
      courseId,
      book_id,
      bookId,
    } = req.body;

    const setClauses = [
      'title = COALESCE($1, title)',
      'description = COALESCE($2, description)',
      'updated_at = NOW()',
    ];
    const params: any[] = [title, description, id];

    if (unit_number !== undefined) {
      params.push(unit_number);
      setClauses.splice(2, 0, `unit_number = $${params.length}`);
    }
    if (unit_name !== undefined) {
      params.push(unit_name);
      setClauses.splice(2, 0, `unit_name = $${params.length}`);
    }
    if (order_index !== undefined) {
      params.push(order_index);
      setClauses.splice(2, 0, `order_index = $${params.length}`);
    }
    const nextCourseId = course_id ?? courseId;
    if (nextCourseId !== undefined) {
      params.push(nextCourseId);
      setClauses.splice(2, 0, `course_id = $${params.length}`);
    }
    const nextBookId = book_id ?? bookId;
    if (nextBookId !== undefined) {
      params.push(nextBookId);
      setClauses.splice(2, 0, `book_id = $${params.length}`);
    }

    const result = await pool.query(
      `UPDATE lessons SET ${setClauses.join(', ')} WHERE id = $3 RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Lesson not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error updating lesson:', error);
    res.status(500).json({ success: false, error: 'Failed to update lesson' });
  }
});

// GET /lessons/:lessonId/activities - Get all activities for a lesson
// ?slim=1 strips content_data for fast initial load; default returns full data
app.get('/lessons/:lessonId/activities', async (req, res) => {
  try {
    const { lessonId } = req.params;
    const slim = req.query.slim === '1';
    // slim mode strips content_data and replaces base64 data: URLs with NULL to keep payload tiny
    const cols = slim
      ? `id, lesson_id, type, title, subtitle,
         CASE WHEN content_url LIKE 'data:%' THEN NULL ELSE content_url END AS content_url,
         order_index, points, created_at`
      : '*';

    const result = await pool.query(
      `SELECT ${cols} FROM lesson_activities WHERE lesson_id = $1 ORDER BY order_index`,
      [lessonId]
    );

    res.json({ success: true, data: result.rows.map(withCdnUrls) });
  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch activities' });
  }
});

// GET /lessons/:lessonId/activities/:activityId - Get single activity with full content_data
app.get('/lessons/:lessonId/activities/:activityId', async (req, res) => {
  try {
    const { lessonId, activityId } = req.params;
    if (!isUuid(activityId) || !isUuid(lessonId)) {
      return res.status(400).json({ success: false, error: 'lessonId and activityId must be UUIDs' });
    }
    const result = await pool.query(
      'SELECT * FROM lesson_activities WHERE id = $1 AND lesson_id = $2',
      [activityId, lessonId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Activity not found' });
    }
    res.json({ success: true, data: withCdnUrls(result.rows[0]) });
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch activity' });
  }
});

// POST /lessons/:lessonId/activities - Add activity to lesson
app.post('/lessons/:lessonId/activities', async (req, res) => {
  try {
    const { lessonId } = req.params;
    const { type, title, subtitle, contentUrl, contentData, points } = req.body;

    // Get next order_index
    const maxOrder = await pool.query(
      'SELECT MAX(order_index) as max FROM lesson_activities WHERE lesson_id = $1',
      [lessonId]
    );
    const nextOrder = (maxOrder.rows[0].max || 0) + 1;

    const result = await pool.query(`
      INSERT INTO lesson_activities
      (lesson_id, type, title, subtitle, content_url, content_data, order_index, points)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [lessonId, type, title, subtitle || null, contentUrl || null,
        contentData ? JSON.stringify(contentData) : null, nextOrder, points || 10]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating activity:', error);
    res.status(500).json({ error: 'Failed to create activity' });
  }
});

// PUT /lessons/:lessonId/activities/reorder - Reorder activities
// (must come before /:activityId route вЂ” Express matches in registration order)
app.put('/lessons/:lessonId/activities/reorder', async (req, res) => {
  const client = await pool.connect();
  try {
    const { lessonId } = req.params;
    const { activityIds } = req.body as { activityIds: string[] };

    if (!Array.isArray(activityIds) || activityIds.length === 0) {
      return res.status(400).json({ success: false, error: 'activityIds must be a non-empty array' });
    }
    if (!activityIds.every(isUuid)) {
      return res.status(400).json({ success: false, error: 'activityIds must all be UUIDs' });
    }

    await client.query('BEGIN');
    for (let i = 0; i < activityIds.length; i++) {
      await client.query(
        'UPDATE lesson_activities SET order_index = $1 WHERE id = $2 AND lesson_id = $3',
        [i, activityIds[i], lessonId]
      );
    }
    await client.query('COMMIT');

    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error reordering activities:', error);
    res.status(500).json({ success: false, error: 'Failed to reorder activities' });
  } finally {
    client.release();
  }
});

// PUT /lessons/:lessonId/activities/:activityId - Update activity
app.put('/lessons/:lessonId/activities/:activityId', async (req, res) => {
  try {
    const { activityId } = req.params;
    if (!isUuid(activityId)) {
      return res.status(400).json({ success: false, error: 'activityId must be a UUID' });
    }
    const { type, title, subtitle, contentUrl, contentData, points } = req.body;
    const orderIndex = req.body.order_index ?? req.body.orderIndex ?? null;

    const result = await pool.query(`
      UPDATE lesson_activities
      SET type = COALESCE($1, type),
          title = COALESCE($2, title),
          subtitle = COALESCE($3, subtitle),
          content_url = COALESCE($4, content_url),
          content_data = CASE
            WHEN $5::jsonb IS NULL THEN content_data
            ELSE COALESCE(content_data, '{}'::jsonb) || $5::jsonb
          END,
          points = COALESCE($6, points),
          order_index = COALESCE($8, order_index)
      WHERE id = $7
      RETURNING *
    `, [type, title, subtitle, contentUrl,
        contentData ? JSON.stringify(contentData) : null, points, activityId, orderIndex]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error updating activity:', error);
    res.status(500).json({ error: 'Failed to update activity' });
  }
});

// DELETE /lessons/:lessonId/activities/:activityId - Delete activity
app.delete("/lessons/:lessonId/activities/:activityId", async (req, res) => {
  try {
    const { lessonId, activityId } = req.params;
    if (!isUuid(activityId) || !isUuid(lessonId)) {
      return res.status(400).json({ success: false, error: 'lessonId and activityId must be UUIDs' });
    }

    const result = await pool.query(`
      DELETE FROM lesson_activities
      WHERE id = $1 AND lesson_id = $2
      RETURNING *
    `, [activityId, lessonId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Activity not found" });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Error deleting activity:", error);
    res.status(500).json({ success: false, error: "Failed to delete activity" });
  }
});

// ========== SESSION MANAGEMENT ENDPOINTS ==========

// GET /lessons/:id/active-session - Check if lesson has active session
app.get('/lessons/:id/active-session', async (req, res) => {
  try {
    const { id: lessonId } = req.params;
    const { groupId } = req.query;

    const result = await pool.query(
      `SELECT 
        ls.*,
        COUNT(DISTINCT sp.id) FILTER (WHERE sp.role = 'student' AND sp.is_online = true) as student_count
       FROM lesson_sessions ls
       LEFT JOIN session_participants sp ON sp.session_id = ls.id
       WHERE ls.lesson_id = $1 
       AND ($2::INTEGER IS NULL OR ls.group_id = $2)
       AND ls.is_active = true
       GROUP BY ls.id
       ORDER BY ls.created_at DESC
       LIMIT 1`,
      [lessonId, groupId || null]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, session: null });
    }

    const session = result.rows[0];

    res.json({
      success: true,
      session: {
        id: session.id,
        lessonId: session.lesson_id,
        groupId: session.group_id,
        currentActivityIndex: session.current_activity_index,
        isActive: session.is_active,
        isInteractiveEnabled: session.is_interactive_enabled,
        studentCount: parseInt(session.student_count) || 0,
        createdAt: session.created_at,
      }
    });

  } catch (error) {
    console.error('Error fetching active session:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch active session' });
  }
});

// POST /sessions - Create new session (teacher)
app.post('/sessions', async (req, res) => {
  try {
    const { lessonId, groupId, teacherId } = req.body;

    if (!lessonId) {
      return res.status(400).json({ success: false, error: 'lessonId is required' });
    }

    // Check if active session already exists
    const existing = await pool.query(
      'SELECT * FROM lesson_sessions WHERE lesson_id = $1 AND group_id = $2 AND is_active = true',
      [lessonId, groupId || null]
    );

    if (existing.rows.length > 0) {
      return res.json({
        success: true,
        session: existing.rows[0],
        message: 'Session already active'
      });
    }

    // Create new session
    const result = await pool.query(
      `INSERT INTO lesson_sessions (lesson_id, group_id, teacher_id, current_activity_index, is_active)
       VALUES ($1, $2, $3, 0, true)
       RETURNING *`,
      [lessonId, groupId || null, teacherId || null]
    );

    res.json({ success: true, session: result.rows[0] });

  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ success: false, error: 'Failed to create session' });
  }
});

// PUT /sessions/:id/activity - Update current activity index
app.put('/sessions/:id/activity', async (req, res) => {
  try {
    const { id } = req.params;
    const { activityIndex } = req.body;

    if (activityIndex === undefined) {
      return res.status(400).json({ success: false, error: 'activityIndex is required' });
    }

    const result = await pool.query(
      'UPDATE lesson_sessions SET current_activity_index = $1, updated_at = NOW() WHERE id = $2 AND is_active = true RETURNING *',
      [activityIndex, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Active session not found' });
    }

    res.json({ success: true, session: result.rows[0] });

  } catch (error) {
    console.error('Error updating session activity:', error);
    res.status(500).json({ success: false, error: 'Failed to update activity' });
  }
});

// DELETE /sessions/:id - End session
app.delete('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'UPDATE lesson_sessions SET is_active = false, ended_at = NOW() WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    res.json({ success: true, session: result.rows[0] });

  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({ success: false, error: 'Failed to end session' });
  }
});

// GET /sessions/:id - Get session details
app.get('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const sessionResult = await pool.query(
      'SELECT * FROM lesson_sessions WHERE id = $1',
      [id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const participantsResult = await pool.query(
      'SELECT display_name, role, is_online, joined_at FROM session_participants WHERE session_id = $1 ORDER BY joined_at',
      [id]
    );

    const session = sessionResult.rows[0];

    res.json({
      success: true,
      session: {
        ...session,
        participants: participantsResult.rows
      }
    });

  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch session' });
  }
});

// POST /auth/register - Registration with password
app.post('/auth/register', async (req, res) => {
  try {
    const { email, displayName, password } = req.body;

    if (!email || !displayName || !password) {
      return res.status(400).json({ success: false, error: 'Email, name and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    // Check if user already exists
    const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'User already exists' });
    }

    const bcrypt = require('bcrypt');
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(`
      INSERT INTO users (email, display_name, role, auth_provider, password_hash)
      VALUES ($1, $2, 'teacher', 'email', $3)
      RETURNING *
    `, [email, displayName, passwordHash]);

    const user = result.rows[0];
    const token = Buffer.from(`${user.id}:${Date.now()}`).toString('base64');

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          role: user.role,
          avatarColor: user.avatar_color || '#3B82F6',
        },
      },
    });
  } catch (error) {
    console.error('Error in registration:', error);
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// POST /auth/login - Login with password
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    // Find user by email
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = result.rows[0];

    // If user has a password вЂ” verify it
    if (user.password_hash) {
      if (!password) {
        return res.status(401).json({ success: false, error: 'Password is required' });
      }
      const bcrypt = require('bcrypt');
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) {
        return res.status(401).json({ success: false, error: 'Invalid password' });
      }
    }
    // Google-auth users (no password_hash) log in via Google, not this endpoint

    const token = Buffer.from(`${user.id}:${Date.now()}`).toString('base64');

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          role: user.role,
          avatarColor: user.avatar_color || '#3B82F6',
        },
      },
    });
  } catch (error) {
    console.error('Error in login:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// ===== COURSES API =====

const SPOTLIGHT_COURSE_ID = 'e50d66db-8350-449e-bfd5-2771b43ba8e2';

// GET /courses - trial => only Spotlight; subscription => all
app.get('/courses', async (req, res) => {
  try {
    const { teacherId } = req.query;
    const coursesResult = await pool.query('SELECT * FROM courses ORDER BY created_at ASC');
    if (!teacherId) {
      return res.json({ success: true, data: coursesResult.rows.map((c: any) => ({ ...c, has_access: true })) });
    }
    const subResult = await pool.query(
      'SELECT u.created_at as registered_at, ts.expires_at'
      + ' FROM users u'
      + ' LEFT JOIN teacher_subscriptions ts ON ts.teacher_id = u.id'
      + ' WHERE u.id = $1',
      [teacherId]
    );
    let status = 'none';
    if (subResult.rows.length > 0) {
      const row = subResult.rows[0];
      const now = new Date();
      if (row.expires_at && new Date(row.expires_at) > now) {
        status = 'subscribed';
      } else {
        const trialEnd = new Date(new Date(row.registered_at).getTime() + 3 * 86400000);
        if (trialEnd > now) status = 'trial';
      }
    }
    const data = coursesResult.rows.map((c: any) => {
      const access = status === 'subscribed' || (status === 'trial' && c.id === SPOTLIGHT_COURSE_ID);
      return { ...c, has_access: access };
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch courses' });
  }
});

// GET /teacher-subscription - Get teacher subscription status
app.get('/teacher-subscription', async (req, res) => {
  try {
    const { teacherId } = req.query;
    if (!teacherId) return res.status(400).json({ success: false, error: 'teacherId required' });
    const result = await pool.query(
      'SELECT u.created_at as registered_at, ts.expires_at, ts.plan'
      + ' FROM users u'
      + ' LEFT JOIN teacher_subscriptions ts ON ts.teacher_id = u.id'
      + ' WHERE u.id = $1',
      [teacherId]
    );
    if (result.rows.length === 0) {
      return res.json({ success: true, status: 'trial_expired', daysLeft: 0, plan: null });
    }
    const row = result.rows[0];
    const now = new Date();
    if (row.expires_at) {
      const expiresAt = new Date(row.expires_at);
      const daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / 86400000);
      if (daysLeft > 0) {
        return res.json({ success: true, status: 'active', daysLeft, plan: row.plan, expiresAt: expiresAt.toISOString() });
      }
      return res.json({ success: true, status: 'expired', daysLeft: 0, plan: row.plan });
    }
    const trialEndsAt = new Date(new Date(row.registered_at).getTime() + 3 * 86400000);
    const trialDaysLeft = Math.ceil((trialEndsAt.getTime() - now.getTime()) / 86400000);
    if (trialDaysLeft > 0) {
      return res.json({ success: true, status: 'trial', daysLeft: trialDaysLeft, plan: null, expiresAt: trialEndsAt.toISOString() });
    }
    return res.json({ success: true, status: 'trial_expired', daysLeft: 0, plan: null });
  } catch (error) {
    console.error('Error fetching subscription:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch subscription' });
  }
});

// POST /teacher-subscription - Grant/extend teacher subscription
app.post('/teacher-subscription', async (req, res) => {
  try {
    const { teacherId, days, plan } = req.body;
    if (!teacherId || !days) return res.status(400).json({ success: false, error: 'teacherId and days required' });
    const daysNum = parseInt(days, 10);
    const planName = plan || 'monthly';
    await pool.query(
      `INSERT INTO teacher_subscriptions (teacher_id, expires_at, plan) VALUES ($1, NOW() + INTERVAL '1 day' * $2, $3)
       ON CONFLICT (teacher_id) DO UPDATE SET
       expires_at = GREATEST(teacher_subscriptions.expires_at, NOW()) + INTERVAL '1 day' * $2,
       plan = $3`,
      [teacherId, daysNum, planName]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error granting subscription:', error);
    res.status(500).json({ success: false, error: 'Failed to grant subscription' });
  }
});

// POST /teacher-course-access - Grant teacher access to a course
app.post('/teacher-course-access', async (req, res) => {
  try {
    const { teacherId, courseId } = req.body;
    if (!teacherId || !courseId) return res.status(400).json({ success: false, error: 'teacherId and courseId required' });
    await pool.query(
      'INSERT INTO teacher_course_access (teacher_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [teacherId, courseId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error granting access:', error);
    res.status(500).json({ success: false, error: 'Failed to grant access' });
  }
});

// DELETE /teacher-course-access - Revoke teacher access to a course
app.delete('/teacher-course-access', async (req, res) => {
  try {
    const { teacherId, courseId } = req.body;
    if (!teacherId || !courseId) return res.status(400).json({ success: false, error: 'teacherId and courseId required' });
    await pool.query(
      'DELETE FROM teacher_course_access WHERE teacher_id = $1 AND course_id = $2',
      [teacherId, courseId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error revoking access:', error);
    res.status(500).json({ success: false, error: 'Failed to revoke access' });
  }
});

// GET /admin/teachers - List all teachers with subscription status
app.get('/admin/teachers', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT u.id, u.display_name, u.email, u.created_at, u.avatar_color, ts.expires_at, ts.plan'
      + ' FROM users u'
      + ' LEFT JOIN teacher_subscriptions ts ON ts.teacher_id = u.id'
      + ' WHERE u.role = $1'
      + ' ORDER BY u.created_at DESC',
      ['teacher']
    );
    const now = new Date();
    const teachers = result.rows.map((row: any) => {
      let status: string, daysLeft = 0;
      if (row.expires_at) {
        const expiresAt = new Date(row.expires_at);
        daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / 86400000);
        status = daysLeft > 0 ? 'active' : 'expired';
      } else {
        const trialEndsAt = new Date(new Date(row.created_at).getTime() + 3 * 86400000);
        daysLeft = Math.ceil((trialEndsAt.getTime() - now.getTime()) / 86400000);
        status = daysLeft > 0 ? 'trial' : 'trial_expired';
      }
      return { id: row.id, displayName: row.display_name, email: row.email, avatarColor: row.avatar_color, createdAt: row.created_at, status, daysLeft: Math.max(0, daysLeft), plan: row.plan, expiresAt: row.expires_at };
    });
    res.json({ success: true, data: teachers });
  } catch (error) {
    console.error('Error fetching teachers for admin:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch teachers' });
  }
});

// POST /courses - Create a new course
app.post('/courses', async (req, res) => {
  try {
    const { name, teacherId, description, emoji } = req.body;

    if (!name || !teacherId) {
      return res.status(400).json({ success: false, error: 'Name and teacher ID are required' });
    }

    const result = await pool.query(`
      INSERT INTO courses (name, teacher_id, description, emoji)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [name, teacherId, description || '', emoji || 'рџ“љ']);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error creating course:', error);
    res.status(500).json({ success: false, error: 'Failed to create course' });
  }
});

// GET /courses/:id/books - Get books (levels) for a course
app.get('/courses/:id/books', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM course_books WHERE course_id = $1 ORDER BY order_index, level_number',
      [id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching course books:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch course books' });
  }
});

// POST /courses/:id/books - Create a book for a course
app.post('/courses/:id/books', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, level_number, emoji, order_index } = req.body;
    const result = await pool.query(
      'INSERT INTO course_books (course_id, title, level_number, emoji, order_index) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, title, level_number || null, emoji || 'рџ“–', order_index ?? 0]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error creating course book:', error);
    res.status(500).json({ success: false, error: 'Failed to create course book' });
  }
});

// PUT /books/:id/lessons/reorder - Atomically reorder all lessons in a book
app.put('/books/:id/lessons/reorder', async (req, res) => {
  try {
    const { id } = req.params;
    const { lessonIds } = req.body as { lessonIds: string[] };
    if (!Array.isArray(lessonIds) || lessonIds.length === 0) {
      return res.status(400).json({ success: false, error: 'lessonIds array required' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < lessonIds.length; i++) {
        await client.query(
          'UPDATE lessons SET order_index = $1, updated_at = NOW() WHERE id = $2 AND book_id = $3',
          [i + 1, lessonIds[i], id]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error reordering lessons:', error);
    res.status(500).json({ success: false, error: 'Failed to reorder lessons' });
  }
});

// GET /books/:id/lessons - Get lessons for a book
app.get('/books/:id/lessons', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM lessons WHERE book_id = $1 AND COALESCE(is_deleted, false) = false ORDER BY order_index, created_at',
      [id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching book lessons:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch book lessons' });
  }
});

// GET /books/:id - Get a single book
app.get('/books/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM course_books WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Book not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching book:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch book' });
  }
});

// GET /courses/:id/groups - Get groups assigned to a course with progress
app.get('/courses/:id/groups', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT g.*,
             gc.current_lesson_id,
             l.title as current_lesson_title,
             COALESCE(lesson_counts.total_lessons, 0)::int as total_lessons,
             COALESCE(progress_counts.completed_lessons, 0)::int as completed_lessons
      FROM groups g
      INNER JOIN group_courses gc ON g.id = gc.group_id
      LEFT JOIN lessons l ON gc.current_lesson_id = l.id
      LEFT JOIN (
        SELECT course_id, COUNT(*) as total_lessons
        FROM lessons
        WHERE is_deleted = false
        GROUP BY course_id
      ) lesson_counts ON lesson_counts.course_id = $1::uuid
      LEFT JOIN (
        SELECT glp.group_id, COUNT(DISTINCT glp.lesson_id) as completed_lessons
        FROM group_lesson_progress glp
        INNER JOIN lessons cl ON cl.id = glp.lesson_id
        WHERE glp.is_completed = true AND cl.course_id = $1::uuid
        GROUP BY glp.group_id
      ) progress_counts ON progress_counts.group_id = g.id
      WHERE gc.course_id = $1
      ORDER BY g.name
    `, [id]);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching course groups:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch course groups' });
  }
});

// POST /courses/:id/groups - Assign a group to a course
app.post('/courses/:id/groups', async (req, res) => {
  try {
    const { id } = req.params;
    const { groupId } = req.body;

    if (!groupId) {
      return res.status(400).json({ success: false, error: 'Group ID is required' });
    }

    // Check if already assigned
    const existing = await pool.query(
      'SELECT * FROM group_courses WHERE group_id = $1 AND course_id = $2',
      [groupId, id]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Group is already assigned to this course'
      });
    }

    const result = await pool.query(`
      INSERT INTO group_courses (group_id, course_id, is_active)
      VALUES ($1, $2, true)
      RETURNING *
    `, [groupId, id]);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error assigning group to course:', error);
    res.status(500).json({ success: false, error: 'Failed to assign group to course' });
  }
});

// DELETE /courses/:courseId/groups/:groupId - Remove group from course
app.delete('/courses/:courseId/groups/:groupId', async (req, res) => {
  try {
    const { courseId, groupId } = req.params;

    const result = await pool.query(`
      DELETE FROM group_courses
      WHERE course_id = $1 AND group_id = $2
      RETURNING *
    `, [courseId, groupId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Assignment not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error removing group from course:', error);
    res.status(500).json({ success: false, error: 'Failed to remove group from course' });
  }
});

// PUT /groups/:groupId/current-lesson - Set current lesson for a group
app.put('/groups/:groupId/current-lesson', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { lessonId, courseId } = req.body;

    if (!lessonId) {
      return res.status(400).json({ success: false, error: 'Lesson ID is required' });
    }

    // Update current_lesson_id in group_courses
    const result = await pool.query(`
      UPDATE group_courses
      SET current_lesson_id = $1
      WHERE group_id = $2 AND course_id = $3
      RETURNING *
    `, [lessonId, groupId, courseId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Group not assigned to this course' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error setting current lesson:', error);
    res.status(500).json({ success: false, error: 'Failed to set current lesson' });
  }
});

// ===== GROUPS & STUDENTS API =====

// GET /groups - Get all groups for a teacher
app.get('/groups', async (req, res) => {
  try {
    const { teacherId } = req.query;

    if (!teacherId) {
      return res.status(400).json({ success: false, error: 'Teacher ID is required' });
    }

    const result = await pool.query(`
      SELECT g.*,
             json_agg(
               json_build_object(
                 'id', s.id,
                 'group_id', gs.group_id,
                 'student_name', s.student_name,
                 'login', s.login,
                 'password_hash', s.password_hash,
                 'plain_password', NULL,
                 'points', s.points,
                 'created_at', s.created_at
               ) ORDER BY s.student_name
             ) FILTER (WHERE s.id IS NOT NULL) as students
      FROM groups g
      LEFT JOIN group_students gs ON g.id = gs.group_id
      LEFT JOIN students s ON gs.student_id = s.id
      WHERE g.teacher_id = $1
         OR g.id IN (SELECT group_id FROM group_teacher_access WHERE teacher_id = $1)
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `, [teacherId]);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch groups' });
  }
});

// GET /groups/:id - Get a single group with its students (used by the student scoreboard)
app.get('/groups/:id', async (req, res) => {
  try {
    const groupId = parseInt(req.params.id, 10);
    if (Number.isNaN(groupId)) {
      return res.status(400).json({ success: false, error: 'group id must be a number' });
    }

    const result = await pool.query(`
      SELECT g.*,
             json_agg(
               json_build_object(
                 'id', s.id,
                 'group_id', gs.group_id,
                 'student_name', s.student_name,
                 'login', s.login,
                 'points', s.points,
                 'created_at', s.created_at
               ) ORDER BY s.student_name
             ) FILTER (WHERE s.id IS NOT NULL) as students
      FROM groups g
      LEFT JOIN group_students gs ON g.id = gs.group_id
      LEFT JOIN students s ON gs.student_id = s.id
      WHERE g.id = $1
      GROUP BY g.id
    `, [groupId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }

    const group = result.rows[0];
    if (!group.students) group.students = [];
    res.json({ success: true, data: group });
  } catch (error) {
    console.error('Error fetching group:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch group' });
  }
});

// GET /groups/:groupId/active-session - Check if group has active live session
app.get('/groups/:groupId/active-session', async (req, res) => {
  try {
    const { groupId } = req.params;

    const result = await pool.query(
      "SELECT * FROM live_sessions WHERE group_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      [groupId]
    );

    if (result.rows.length > 0) {
      res.json({ success: true, data: result.rows[0] });
    } else {
      res.json({ success: true, data: null });
    }
  } catch (error) {
    console.error('Error checking active session for group:', error);
    res.status(500).json({ success: false, error: 'Failed to check active session' });
  }
});

// GET /groups/:id/progress - Get lesson progress for a group
app.get('/groups/:id/progress', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT
         progress.lesson_id,
         progress.progress_percent,
         progress.is_completed,
         progress.last_session_id,
         lesson.title AS lesson_title,
         lesson.island_id,
         lesson.order_index
       FROM group_lesson_progress progress
       INNER JOIN lessons lesson ON lesson.id = progress.lesson_id
       WHERE progress.group_id = $1
       ORDER BY lesson.island_id, lesson.order_index`,
      [id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching group progress:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch group progress' });
  }
});

// POST /groups - Create a new group
app.post('/groups', async (req, res) => {
  try {
    const { name, teacherId } = req.body;

    if (!name || !teacherId) {
      return res.status(400).json({ success: false, error: 'Name and teacher ID are required' });
    }

    const result = await pool.query(`
      INSERT INTO groups (name, teacher_id)
      VALUES ($1, $2)
      RETURNING *
    `, [name, teacherId]);

    res.status(201).json({
      success: true,
      data: {
        ...result.rows[0],
        students: []
      }
    });
  } catch (error) {
    console.error('Error creating group:', error);
    res.status(500).json({ success: false, error: 'Failed to create group' });
  }
});

// DELETE /groups/:id - Delete a group
app.delete('/groups/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // First delete all group_students in the group
    await pool.query('DELETE FROM group_students WHERE group_id = $1', [id]);

    // Then delete the group
    const result = await pool.query('DELETE FROM groups WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ success: false, error: 'Failed to delete group' });
  }
});

// GET /groups/:id/students - Get all students in a group
app.get("/groups/:id/students", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT 
        s.id,
        s.student_name,
        s.login,
        
        gs.joined_at
      FROM students s
      JOIN group_students gs ON s.id = gs.student_id
      WHERE gs.group_id = $1
      ORDER BY s.student_name ASC
    `, [id]);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("Error fetching group students:", error);
    res.status(500).json({ success: false, error: "Failed to fetch students" });
  }
});

// POST /groups/:id/students - Add a student to a group
app.post("/groups/:id/students", async (req, res) => {
  console.log("[DEBUG] POST /students called with body:", req.body);
  try {
    const { id } = req.params;
    const { studentId } = req.body;

    // Check if student exists
    const studentCheck = await pool.query("SELECT id FROM students WHERE id = $1", [studentId]);
    if (studentCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Student not found" });
    }

    // Check if group exists
    const groupCheck = await pool.query("SELECT id FROM groups WHERE id = $1", [id]);
    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Group not found" });
    }

    // Add student to group (will fail if already exists due to unique constraint)
    const result = await pool.query(
      "INSERT INTO group_students (group_id, student_id) VALUES ($1, $2) RETURNING *",
      [id, studentId]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    console.error("Error adding student to group:", error);
    
    // Check for duplicate key error
    if (error.code === "23505") {
      return res.status(400).json({ success: false, error: "Student already in group" });
    }
    
    res.status(500).json({ success: false, error: "Failed to add student to group" });
  }
});

// DELETE /groups/:id/students/:studentId - Remove a student from a group
app.delete("/groups/:id/students/:studentId", async (req, res) => {
  try {
    const { id, studentId } = req.params;

    const result = await pool.query(
      "DELETE FROM group_students WHERE group_id = $1 AND student_id = $2 RETURNING *",
      [id, studentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Student not in this group" });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Error removing student from group:", error);
    res.status(500).json({ success: false, error: "Failed to remove student from group" });
  }
});

// GET /students - Get all students (for adding to groups)
app.get("/students", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        student_name,
        login,
        
        created_at
      FROM students
      ORDER BY student_name ASC
    `);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("Error fetching students:", error);
    res.status(500).json({ success: false, error: "Failed to fetch students" });
  }
});

// TutorDesk integration. Credentials are exchanged for a JWT and never stored by UniPlay.
app.post('/tutorsdesk/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Введите email и пароль TutorDesk' });
    const response = await fetch('https://tutorsdesk.ru/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok || !data.token) return res.status(401).json({ success: false, error: data.error || 'Неверный логин или пароль TutorDesk' });
    res.json({ success: true, token: data.token });
  } catch (error) {
    console.error('[TutorDesk] Login failed:', error);
    res.status(502).json({ success: false, error: 'TutorDesk временно недоступен' });
  }
});

app.post('/tutorsdesk/lesson-completion', async (req, res) => {
  try {
    const { token, groupId, topic, homework, attendance } = req.body;
    if (!token || !groupId || !Array.isArray(attendance)) {
      return res.status(400).json({ success: false, error: 'Недостаточно данных для TutorDesk' });
    }
    const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const tdRequest = async (path: string, options: any = {}) => {
      const response = await fetch(`https://tutorsdesk.ru/api${path}`, { ...options, headers: { ...authHeaders, ...(options.headers || {}) } });
      const data: any = await response.json().catch(() => null);
      if (!response.ok) {
        const problem: any = new Error(data?.error || data?.message || `TutorDesk: ${response.status}`);
        problem.status = response.status;
        throw problem;
      }
      return data;
    };

    const localGroup = await pool.query('SELECT name FROM groups WHERE id = $1', [groupId]);
    const localGroupName = localGroup.rows[0]?.name || '';
    const [tdStudentsRaw, tdGroupsRaw] = await Promise.all([tdRequest('/students'), tdRequest('/groups')]);
    const tdStudents = Array.isArray(tdStudentsRaw) ? tdStudentsRaw : (tdStudentsRaw?.data || []);
    const tdGroups = Array.isArray(tdGroupsRaw) ? tdGroupsRaw : (tdGroupsRaw?.data || []);
    const normalize = (value: any) => String(value || '').trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
    const tdGroup = tdGroups.find((group: any) => normalize(group.name) === normalize(localGroupName));
    const today = new Date();
    const isoDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const attendanceDate = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;
    const unmatched: string[] = [];
    const matched: Array<{ tdStudent: any; status: string; name: string }> = [];

    for (const item of attendance) {
      const tdStudent = tdStudents.find((student: any) => normalize(student.fullName || student.name) === normalize(item.name));
      if (!tdStudent) unmatched.push(item.name);
      else matched.push({ tdStudent, status: item.status, name: item.name });
    }

    await Promise.all(matched.map(item => tdRequest('/attendance', {
      method: 'POST',
      body: JSON.stringify({
        studentId: item.tdStudent.id,
        date: attendanceDate,
        status: item.status === 'ABSENT' ? 'ABSENT' : 'PRESENT',
        ...(tdGroup?.id ? { groupId: tdGroup.id } : {}),
      }),
    })));

    const lessonBase = { date: isoDate, topic: topic || 'Урок на UniPlay', homework: homework || '', comment: 'Добавлено после завершения урока в UniPlay' };
    if (tdGroup?.id) {
      await tdRequest('/lessons', { method: 'POST', body: JSON.stringify({ ...lessonBase, groupId: tdGroup.id, studentId: null }) });
    } else {
      await Promise.all(matched.map(item => tdRequest('/lessons', {
        method: 'POST',
        body: JSON.stringify({ ...lessonBase, studentId: item.tdStudent.id, groupId: null }),
      })));
    }

    res.json({ success: true, unmatched, matched: matched.length, groupMatched: Boolean(tdGroup) });
  } catch (error: any) {
    console.error('[TutorDesk] Completion sync failed:', error);
    res.status(error?.status === 401 ? 401 : 502).json({ success: false, error: error?.message || 'Ошибка синхронизации TutorDesk' });
  }
});

// POST /students - Create a new student
app.post('/students', async (req, res) => {
  console.log("[DEBUG] POST /students called with body:", req.body);
  try {
    const { groupId, studentName, login, password } = req.body;

    if (!groupId || !studentName || !login) {
      return res.status(400).json({
        success: false,
        error: 'Group ID, student name and login are required'
      });
    }

    // The teacher UI allows an empty password and promises an automatically generated PIN.
    const generatedPin = password ? null : String(Math.floor(100000 + Math.random() * 900000));
    const effectivePassword = password || generatedPin;

    // Check if login already exists
    const existingStudent = await pool.query(
      'SELECT * FROM students WHERE login = $1',
      [login]
    );

    if (existingStudent.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Р›РѕРіРёРЅ "${login}" СѓР¶Рµ РёСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ`
      });
    }

    // Hash password
    const bcrypt = require('bcrypt');
    const passwordHash = await bcrypt.hash(effectivePassword, 10);

    // Create student in students table
    const studentResult = await pool.query(`
      INSERT INTO students (group_id, student_name, login, password_hash)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [groupId, studentName, login, passwordHash]);

    // Add student to group_students table
    await pool.query(`
      INSERT INTO group_students (group_id, student_id)
      VALUES ($1, $2)
    `, [groupId, studentResult.rows[0].id]);

    res.status(201).json({
      success: true,
      data: studentResult.rows[0],
      generatedPin
    });
  } catch (error: any) {
    console.error('Error creating student:', error); console.error('Error stack:', error.stack);
    res.status(500).json({ success: false, error: 'Failed to create student' });
  }
});

// GET /students/leader - Global leader (most points) across all students
app.get('/students/leader', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.student_name, COALESCE(s.points, 0) AS points, g.name AS group_name
      FROM students s
      LEFT JOIN groups g ON s.group_id = g.id
      ORDER BY s.points DESC NULLS LAST
      LIMIT 1
    `);
    res.json({ success: true, data: result.rows[0] || null });
  } catch (error) {
    console.error('Error fetching global leader:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch leader' });
  }
});

const ISLAND_TWO_ACHIEVEMENTS = [
  'Островные монеты', 'Редкая ракушка', 'Компас путешественника', 'Мешочек островных монет',
  'Перо Коко', 'Кусочек секретной карты', 'Старинный ключ', 'Голубой кристалл',
  'Сундук с монетами', 'Островной тотем', 'Зелье удачи', 'Карта сокровищ',
  'Золотой кокос', 'Сундук с сокровищами', 'Магический камень', 'Золотой ключ',
  'Корона исследователя', 'Сердце острова', 'Талисман острова', 'Главное сокровище',
].map((name, index) => ({
  name,
  imageUrl: `https://storage.yandexcloud.net/kids-app/public-assets/achievements/island-2/achievement-${String(index + 1).padStart(2, '0')}.png`,
}));

const awardIslandTwoAchievements = async (db: any, studentId: number, points: number) => {
  const earnedCount = Math.max(0, Math.min(5, Math.floor((points - 250) / 50)));
  if (earnedCount === 0) return;
  const existingResult = await db.query(`SELECT achievement_key, emoji FROM student_achievements WHERE student_id = $1 AND achievement_key LIKE 'island-2-achievement-%'`, [studentId]);
  const existing = existingResult.rows;
  const usedImages = new Set(existing.map((item: any) => item.emoji));
  for (let slot = 1; slot <= earnedCount; slot += 1) {
    const achievementKey = `island-2-achievement-${slot}`;
    if (existing.some((item: any) => item.achievement_key === achievementKey)) continue;
    const available = ISLAND_TWO_ACHIEVEMENTS.filter((item) => !usedImages.has(item.imageUrl));
    const achievement = available[Math.floor(Math.random() * available.length)];
    await db.query(`INSERT INTO student_achievements (student_id, achievement_key, name, emoji) VALUES ($1, $2, $3, $4)`, [studentId, achievementKey, achievement.name, achievement.imageUrl]);
    usedImages.add(achievement.imageUrl);
  }
};
// GET /students/:id - One student's own data (for the student cabinet)
app.get('/students/:id', async (req, res) => {
  try {
    const studentId = parseInt(req.params.id, 10);
    if (Number.isNaN(studentId)) {
      return res.status(400).json({ success: false, error: 'student id must be a number' });
    }
    const result = await pool.query(`
      SELECT s.id, s.student_name, COALESCE(s.points, 0) AS points, s.group_id, g.name AS group_name
      FROM students s
      LEFT JOIN groups g ON s.group_id = g.id
      WHERE s.id = $1
    `, [studentId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }
    await awardIslandTwoAchievements(pool, studentId, Number(result.rows[0].points));
    const achievementsResult = await pool.query(`
      SELECT achievement_key, name, emoji, earned_at
      FROM student_achievements
      WHERE student_id = $1
      ORDER BY earned_at ASC, id ASC
      LIMIT 15
    `, [studentId]);
    res.json({
      success: true,
      data: {
        ...result.rows[0],
        achievements: achievementsResult.rows,
      },
    });
  } catch (error) {
    console.error('Error fetching student:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch student' });
  }
});

// PATCH/PUT /students/:id/points - Set a student's points
const updateStudentPoints = async (req: any, res: any) => {
  try {
    const studentId = parseInt(req.params.id, 10);
    if (Number.isNaN(studentId)) {
      return res.status(400).json({ success: false, error: 'student id must be a number' });
    }
    const points = Number(req.body?.points);
    if (!Number.isFinite(points) || points < 0) {
      return res.status(400).json({ success: false, error: 'points must be a non-negative number' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'UPDATE students SET points = $1 WHERE id = $2 RETURNING id, student_name, points, group_id',
        [points, studentId]
      );
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Student not found' });
      }
      await awardIslandTwoAchievements(client, studentId, points);
      await client.query('COMMIT');
      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error updating student points:', error);
    res.status(500).json({ success: false, error: 'Failed to update points' });
  }
};
app.patch('/students/:id/points', updateStudentPoints);
app.put('/students/:id/points', updateStudentPoints);

// PUT /students/:id - Update student credentials
app.put('/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { login, password } = req.body;

    // Allow empty login (will be stored as empty string or null)
    const loginValue = login && login.trim() !== '' ? login.trim() : null;

    // Check if login is already used by another student (only if login is not empty)
    if (loginValue) {
      const existingStudent = await pool.query(
        'SELECT * FROM students WHERE login = $1 AND id != $2',
        [loginValue, id]
      );

      if (existingStudent.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Р›РѕРіРёРЅ "${loginValue}" СѓР¶Рµ РёСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ РґСЂСѓРіРёРј СѓС‡РµРЅРёРєРѕРј`
        });
      }
    }

    let result;

    if (password && password.trim() !== '') {
      // Update both login and password
      const bcrypt = require('bcrypt');
      const passwordHash = await bcrypt.hash(password, 10);

      result = await pool.query(`
        UPDATE students
        SET login = $1, password_hash = $2
        WHERE id = $3
        RETURNING *
      `, [loginValue, passwordHash, id]);
    } else {
      // Update only login
      result = await pool.query(`
        UPDATE students
        SET login = $1
        WHERE id = $2
        RETURNING *
      `, [loginValue, id]);
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error updating student:', error);
    res.status(500).json({ success: false, error: 'Failed to update student' });
  }
});

// DELETE /students/:id - Delete a student
app.delete('/students/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query('DELETE FROM group_students WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error deleting student:', error);
    res.status(500).json({ success: false, error: 'Failed to delete student' });
  }
});

// POST /auth/student-login - Student login
app.post('/auth/student-login', async (req, res) => {
  try {
    const { login, password } = req.body;

    if (!login || !password) {
      return res.status(400).json({ success: false, error: 'Login and password are required' });
    }

    // Find student by login
    const result = await pool.query(`
      SELECT s.*, g.name as group_name
      FROM students s
      JOIN groups g ON s.group_id = g.id
      WHERE s.login = $1
    `, [login]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'РќРµРІРµСЂРЅС‹Р№ Р»РѕРіРёРЅ РёР»Рё РїР°СЂРѕР»СЊ' });
    }

    const student = result.rows[0];

    // Verify password
    const bcrypt = require('bcrypt');
    const passwordMatch = await bcrypt.compare(password, student.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ success: false, error: 'РќРµРІРµСЂРЅС‹Р№ Р»РѕРіРёРЅ РёР»Рё РїР°СЂРѕР»СЊ' });
    }

    // Generate token
    const token = Buffer.from(`student:${student.id}:${Date.now()}`).toString('base64');

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: student.id.toString(),
          displayName: student.student_name,
          role: 'student',
          groupId: student.group_id,
          groupName: student.group_name,
          avatarColor: '#10B981',
        },
      },
    });
  } catch (error) {
    console.error('Error in student login:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// POST /auth/google - Google OAuth authentication
app.post('/auth/google', async (req, res) => {
  try {
    const { code, redirectUri } = req.body;

    if (!code) {
      return res.status(400).json({ success: false, error: 'Code is required' });
    }

    // Exchange authorization code for access token
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      console.error('Google token error:', tokenData);
      return res.status(400).json({ success: false, error: 'Failed to get access token', details: tokenData });
    }

    // Get user info from Google
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    const googleUser = await userInfoResponse.json();

    if (!googleUser.email) {
      return res.status(400).json({ success: false, error: 'Failed to get user info' });
    }

    // Check if user exists in database, if not create them
    let userResult = await pool.query('SELECT * FROM users WHERE email = $1', [googleUser.email]);

    if (userResult.rows.length === 0) {
      // Create new user
      userResult = await pool.query(`
        INSERT INTO users (email, display_name, role, auth_provider, google_id)
        VALUES ($1, $2, 'teacher', 'google', $3)
        RETURNING *
      `, [googleUser.email, googleUser.name, googleUser.id]);
    }

    const user = userResult.rows[0];

    // Generate a simple token (in production, use JWT)
    const token = Buffer.from(`${user.id}:${Date.now()}`).toString('base64');

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          role: user.role,
          avatarColor: user.avatar_color || '#3B82F6',
        },
      },
    });
  } catch (error) {
    console.error('Error in Google OAuth:', error);
    res.status(500).json({ success: false, error: 'Google authentication failed' });
  }
});

// ==================== LIVE SESSIONS ENDPOINTS ====================

// POST /live-sessions - Create new live session
app.post('/live-sessions', async (req, res) => {
  try {
    const { lessonId, groupId, teacherId } = req.body;

    if (!lessonId || !groupId || !teacherId) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // End any existing active session for this group before creating a new one
    await pool.query(
      "UPDATE live_sessions SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE group_id = $1 AND status = 'active'",
      [groupId]
    );

    const result = await pool.query(`
      INSERT INTO live_sessions (lesson_id, group_id, teacher_id, status, current_step_index)
      VALUES ($1, $2, $3, 'active', 0)
      RETURNING *
    `, [lessonId, groupId, teacherId]);

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error creating live session:', error);
    res.status(500).json({ success: false, error: 'Failed to create live session' });
  }
});

// GET /live-sessions/:sessionId - Get live session details
app.get('/live-sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const result = await pool.query(
      `SELECT ls.*, ls.current_step_index AS current_activity_index, c.name AS course_name
       FROM live_sessions ls
       LEFT JOIN lessons l ON l.id = ls.lesson_id
       LEFT JOIN courses c ON c.id = l.course_id
       WHERE ls.id = $1`,
      [sessionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching live session:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch live session' });
  }
});

// PUT /live-sessions/:sessionId/activity - Teacher sets current activity (persisted so students
// see the same activity after refresh)
app.put('/live-sessions/:sessionId/activity', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { activityIndex } = req.body;

    if (activityIndex === undefined || activityIndex === null) {
      return res.status(400).json({ success: false, error: 'activityIndex is required' });
    }

    const result = await pool.query(
      'UPDATE live_sessions SET current_step_index = $1, updated_at = NOW() WHERE id = $2 RETURNING *, current_step_index AS current_activity_index',
      [activityIndex, sessionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error updating live session activity:', error);
    res.status(500).json({ success: false, error: 'Failed to update activity' });
  }
});

// POST /live-sessions/:sessionId/results - Student submits activity result
app.post('/live-sessions/:sessionId/results', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const {
      activityId, lessonId,
      studentId, studentName,
      score, status, timeSeconds, details, groupId,
    } = req.body;

    if (!activityId) {
      return res.status(400).json({ success: false, error: 'activityId is required' });
    }

    // UPSERT вЂ” one row per (session, activity, student)
    const result = await pool.query(
      `INSERT INTO activity_results
         (session_id, lesson_id, activity_id, student_id, student_name, score, status, time_seconds, details, group_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (session_id, activity_id, student_id) DO UPDATE
       SET score = EXCLUDED.score,
           status = EXCLUDED.status,
           time_seconds = EXCLUDED.time_seconds,
           details = EXCLUDED.details,
           student_name = EXCLUDED.student_name,
           group_id = EXCLUDED.group_id,
           updated_at = NOW()
       RETURNING *`,
      [sessionId === 'none' ? null : sessionId, lessonId || null, activityId,
       studentId || null, studentName || null,
       score || 0, status || 'completed', timeSeconds || null,
       details ? JSON.stringify(details) : null, groupId || null]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error saving activity result:', error);
    res.status(500).json({ success: false, error: 'Failed to save result' });
  }
});

// GET /live-sessions/:sessionId/results - Teacher fetches all results for the session
app.get('/live-sessions/:sessionId/results', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await pool.query(
      `SELECT * FROM activity_results WHERE session_id = $1 ORDER BY created_at DESC`,
      [sessionId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching session results:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch results' });
  }
});

app.get('/lessons/:lessonId/results', async (req, res) => {
  try {
    const { lessonId } = req.params;
    const groupId = req.query.groupId ? Number(req.query.groupId) : null;
    const values: any[] = [lessonId];
    let groupFilter = '';
    if (groupId) {
      values.push(groupId);
      groupFilter = ` AND (
        ar.group_id = $${values.length}
        OR (
          ar.group_id IS NULL
          AND (
            EXISTS (SELECT 1 FROM group_students gs WHERE gs.group_id = $${values.length} AND gs.student_id = ar.student_id)
            OR EXISTS (SELECT 1 FROM students s WHERE s.group_id = $${values.length} AND s.id = ar.student_id)
          )
        )
      )`;
    }
    const result = await pool.query(
      `SELECT ar.* FROM activity_results ar
       WHERE ar.lesson_id = $1${groupFilter}
       ORDER BY ar.created_at DESC`,
      values
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching lesson results:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch lesson results' });
  }
});

type GrammarMistake = {
  topic: string;
  prompt: string;
  studentAnswer: string;
  correctAnswer: string;
};

let grammarTablesReady: Promise<any> | null = null;
const ensureGrammarTables = () => {
  if (!grammarTablesReady) {
    grammarTablesReady = pool.query(`
      CREATE TABLE IF NOT EXISTS student_grammar_mistakes (
        id BIGSERIAL PRIMARY KEY,
        student_id TEXT NOT NULL,
        student_name TEXT,
        lesson_id UUID NOT NULL,
        session_id UUID,
        activity_id UUID,
        topic TEXT NOT NULL,
        prompt TEXT NOT NULL,
        student_answer TEXT NOT NULL,
        correct_answer TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_grammar_mistakes_student ON student_grammar_mistakes(student_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_grammar_mistakes_session ON student_grammar_mistakes(session_id);
      CREATE TABLE IF NOT EXISTS student_grammar_analyses (
        id BIGSERIAL PRIMARY KEY,
        student_id TEXT NOT NULL,
        lesson_id UUID,
        session_id UUID,
        lesson_mistakes JSONB NOT NULL,
        accumulated_mistakes JSONB NOT NULL,
        analysis_text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_grammar_analyses_student ON student_grammar_analyses(student_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS student_grammar_exercise_sets (
        id BIGSERIAL PRIMARY KEY,
        student_id TEXT NOT NULL,
        session_id UUID,
        source_analysis_id BIGINT REFERENCES student_grammar_analyses(id) ON DELETE SET NULL,
        exercise_count INTEGER NOT NULL DEFAULT 10,
        generated_text TEXT NOT NULL,
        student_answers JSONB,
        score INTEGER,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE student_grammar_exercise_sets ADD COLUMN IF NOT EXISTS student_answers JSONB;
      ALTER TABLE student_grammar_exercise_sets ADD COLUMN IF NOT EXISTS score INTEGER;
      ALTER TABLE student_grammar_exercise_sets ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_grammar_exercises_student ON student_grammar_exercise_sets(student_id, created_at DESC);
    `).catch((error: any) => {
      grammarTablesReady = null;
      throw error;
    });
  }
  return grammarTablesReady;
};

const extractWrittenGrammarMistakes = (rawResults: any, topic: string): GrammarMistake[] => {
  const isHskResult = rawResults?.source === 'hsk3' || rawResults?.source === 'hsk3-lesson1';
  const details = Array.isArray(rawResults)
    ? rawResults
    : [rawResults?.answers, rawResults?.details, rawResults?.items].find(Array.isArray) || [];
  return details.flatMap((detail: any) => {
    const isCorrect = detail?.isCorrect ?? detail?.correct;
    if (!detail || (isCorrect !== false && !(isHskResult && isCorrect == null))) return [];
    const studentAnswer = String(detail.studentAnswer ?? detail.chosen ?? detail.answer ?? '').trim();
    const correctAnswer = String(
      detail.correctAnswer ?? detail.correctPronoun ?? detail.correction ??
      (isHskResult ? 'Review this HSK 3 answer using the exercise context' : '')
    ).trim();
    if (!studentAnswer || !correctAnswer) return [];
    return [{
      topic,
      prompt: String(detail.prompt ?? detail.question ?? detail.item ?? detail.statement ?? detail.sentence ?? topic).trim(),
      studentAnswer,
      correctAnswer,
    }];
  });
};

const saveWrittenGrammarMistakes = async (input: {
  studentId?: string; studentName?: string; lessonId: string; sessionId?: string;
  activityId?: string; topic: string; results: any;
}) => {
  if (!input.studentId) return 0;
  const mistakes = extractWrittenGrammarMistakes(input.results, input.topic);
  if (!mistakes.length) return 0;
  await ensureGrammarTables();
  const crypto = require('crypto');
  for (const mistake of mistakes) {
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      studentId: input.studentId, lessonId: input.lessonId, sessionId: input.sessionId || null,
      activityId: input.activityId || null, ...mistake,
    })).digest('hex');
    await pool.query(`
      INSERT INTO student_grammar_mistakes
        (student_id, student_name, lesson_id, session_id, activity_id, topic, prompt, student_answer, correct_answer, fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (fingerprint) DO NOTHING
    `, [input.studentId, input.studentName || null, input.lessonId, input.sessionId || null,
      input.activityId || null, mistake.topic, mistake.prompt, mistake.studentAnswer, mistake.correctAnswer, fingerprint]);
  }
  return mistakes.length;
};

const hskChatRate = new Map<string, { startedAt: number; count: number }>();

app.post('/hsk/chat', async (req, res) => {
  try {
    if (!process.env.DEEPSEEK_API_KEY) {
      return res.status(503).json({ success: false, error: 'AI assistant is not configured' });
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rate = hskChatRate.get(ip);
    if (!rate || now - rate.startedAt > 10 * 60 * 1000) {
      hskChatRate.set(ip, { startedAt: now, count: 1 });
    } else if (rate.count >= 30) {
      return res.status(429).json({ success: false, error: 'Too many requests' });
    } else {
      rate.count += 1;
    }

    const message = String(req.body?.message || '').trim().slice(0, 2000);
    if (!message) return res.status(400).json({ success: false, error: 'Message is required' });

    const history = Array.isArray(req.body?.history)
      ? req.body.history.slice(-12).map((item: any) => ({
          role: item?.role === 'assistant' ? 'assistant' : 'user',
          content: String(item?.content || '').slice(0, 2000),
        })).filter((item: any) => item.content)
      : [];
    const context = String(req.body?.context || '').replace(/\s+/g, ' ').trim().slice(0, 4000);

    const aiResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.25,
        max_tokens: 900,
        messages: [
          {
            role: 'system',
            content: `РўС‹ РґРѕР±СЂРѕР¶РµР»Р°С‚РµР»СЊРЅС‹Р№ РїСЂРµРїРѕРґР°РІР°С‚РµР»СЊ РєРёС‚Р°Р№СЃРєРѕРіРѕ СЏР·С‹РєР° СѓСЂРѕРІРЅСЏ HSK 3. РћС‚РІРµС‡Р°Р№ РїРѕ-СЂСѓСЃСЃРєРё. РљРёС‚Р°Р№СЃРєРёРµ РїСЂРёРјРµСЂС‹ РІСЃРµРіРґР° СЃРѕРїСЂРѕРІРѕР¶РґР°Р№ РїРёРЅСЊРёРЅРµРј Рё РїРµСЂРµРІРѕРґРѕРј. РЎРЅР°С‡Р°Р»Р° РґР°Р№ РєРѕСЂРѕС‚РєРѕРµ РїСЂР°РІРёР»Рѕ, Р·Р°С‚РµРј 2-4 РїСЂРёРјРµСЂР°. Р•СЃР»Рё СѓС‡РµРЅРёРє РїСЂРѕСЃРёС‚ РїСЂРѕРІРµСЂРёС‚СЊ РїСЂРµРґР»РѕР¶РµРЅРёРµ, РїРѕРєР°Р¶Рё РёСЃРїСЂР°РІР»РµРЅРЅС‹Р№ РІР°СЂРёР°РЅС‚ Рё РєСЂР°С‚РєРѕ РѕР±СЉСЏСЃРЅРё РѕС€РёР±РєСѓ. РќРµ РІС‹С…РѕРґРё Р·Р° СЂР°РјРєРё РёР·СѓС‡РµРЅРёСЏ РєРёС‚Р°Р№СЃРєРѕРіРѕ СЏР·С‹РєР°. РљРѕРЅС‚РµРєСЃС‚ С‚РµРєСѓС‰РµРіРѕ СЌРєСЂР°РЅР°: ${context || 'HSK 3, СѓСЂРѕРє 1'}`,
          },
          ...history,
          { role: 'user', content: message },
        ],
      }),
    });

    if (!aiResponse.ok) {
      throw new Error(`DeepSeek API returned ${aiResponse.status}`);
    }
    const data: any = await aiResponse.json();
    const reply = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!reply) throw new Error('DeepSeek returned an empty answer');
    res.json({ success: true, reply });
  } catch (error) {
    console.error('HSK chat failed:', error);
    res.status(500).json({ success: false, error: 'Failed to get AI response' });
  }
});

const analyzeGrammarForSession = async (sessionId: string) => {
  await ensureGrammarTables();
  const sessionResults = await pool.query(`
    SELECT sr.*, COALESCE(la.title, 'Grammar') AS activity_title
    FROM spotlight_results sr
    LEFT JOIN lesson_activities la ON la.id = sr.activity_id
    WHERE sr.session_id = $1
  `, [sessionId]);
  for (const row of sessionResults.rows) {
    await saveWrittenGrammarMistakes({
      studentId: row.student_id,
      studentName: row.student_name,
      lessonId: row.lesson_id,
      sessionId: row.session_id,
      activityId: row.activity_id,
      topic: row.activity_title,
      results: row.results,
    });
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY is not configured; grammar mistakes were saved but not analyzed');
    return;
  }
  const students = await pool.query(
    'SELECT DISTINCT student_id FROM student_grammar_mistakes WHERE session_id = $1', [sessionId]
  );
  for (const student of students.rows) {
    const lessonRows = await pool.query(
      'SELECT * FROM student_grammar_mistakes WHERE session_id = $1 AND student_id = $2 ORDER BY created_at',
      [sessionId, student.student_id]
    );
    const allRows = await pool.query(
      'SELECT * FROM student_grammar_mistakes WHERE student_id = $1 ORDER BY created_at', [student.student_id]
    );
    if (!lessonRows.rows.length) continue;
    const lessonMistakes = lessonRows.rows.map((row: any) => ({ topic: row.topic, prompt: row.prompt, studentAnswer: row.student_answer, correctAnswer: row.correct_answer }));
    const accumulatedMistakes = allRows.rows.map((row: any) => ({ lessonId: row.lesson_id, topic: row.topic, prompt: row.prompt, studentAnswer: row.student_answer, correctAnswer: row.correct_answer }));
    const aiResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat', temperature: 0.2, max_tokens: 1200,
        messages: [
          { role: 'system', content: 'РўС‹ РјРµС‚РѕРґРёСЃС‚ РїРѕ Р°РЅРіР»РёР№СЃРєРѕР№ РіСЂР°РјРјР°С‚РёРєРµ РґР»СЏ РґРµС‚РµР№. РџСЂРѕР°РЅР°Р»РёР·РёСЂСѓР№ РѕС€РёР±РєРё СѓС‡РµРЅРёРєР°. РћС‚РґРµР»Рё РѕС€РёР±РєРё С‚РµРєСѓС‰РµРіРѕ СѓСЂРѕРєР° РѕС‚ СѓСЃС‚РѕР№С‡РёРІС‹С… РїСЂРѕР±РµР»РѕРІ РїРѕ РІСЃРµР№ РёСЃС‚РѕСЂРёРё. Р’РµСЂРЅРё РєСЂР°С‚РєРёР№ JSON СЃ РїРѕР»СЏРјРё lessonErrors, persistentGaps, priorities, teacherSummary. Р’СЃРµ Р·РЅР°С‡РµРЅРёСЏ Рё СЂРµРєРѕРјРµРЅРґР°С†РёРё РІРЅСѓС‚СЂРё JSON РїРёС€Рё С‚РѕР»СЊРєРѕ РЅР° СЂСѓСЃСЃРєРѕРј СЏР·С‹РєРµ. РќРµ СЃС‡РёС‚Р°Р№ РѕРїРµС‡Р°С‚РєСѓ РіСЂР°РјРјР°С‚РёС‡РµСЃРєРёРј РїСЂРѕР±РµР»РѕРј Р±РµР· РїРѕРІС‚РѕСЂСЏСЋС‰РёС…СЃСЏ РїСЂРёР·РЅР°РєРѕРІ.' },
          { role: 'system', content: 'The lesson may be Chinese HSK or English. Detect the language from the submitted work. For HSK, analyze Chinese vocabulary and grammar; for English, analyze English. Include ungraded written answers in the review. Return concise JSON with lessonErrors, persistentGaps, priorities, teacherSummary, with every user-facing value written in Russian.' },
          { role: 'user', content: JSON.stringify({ lessonMistakes, accumulatedMistakes }) },
        ],
      }),
    });
    if (!aiResponse.ok) throw new Error(`DeepSeek API returned ${aiResponse.status}: ${await aiResponse.text()}`);
    const aiData: any = await aiResponse.json();
    const analysisText = aiData.choices?.[0]?.message?.content || '{}';
    await pool.query(`
      INSERT INTO student_grammar_analyses
        (student_id, lesson_id, session_id, lesson_mistakes, accumulated_mistakes, analysis_text)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [student.student_id, lessonRows.rows[0].lesson_id, sessionId,
      JSON.stringify(lessonMistakes), JSON.stringify(accumulatedMistakes), analysisText]);
  }
};

// DELETE /live-sessions/:sessionId - End live session
app.delete('/live-sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await pool.query(
      `UPDATE live_sessions SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [sessionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const session = result.rows[0];
    const { lesson_id, group_id, current_step_index } = session;

    // Calculate and save progress for this group+lesson
    if (lesson_id && group_id) {
      try {
        const totalResult = await pool.query(
          'SELECT COUNT(*) FROM lesson_activities WHERE lesson_id = $1',
          [lesson_id]
        );
        const totalActivities = parseInt(totalResult.rows[0].count, 10);
        if (totalActivities > 0) {
          const progressPercent = Math.min(
            100,
            Math.round(((current_step_index || 0) + 1) / totalActivities * 100)
          );
          const isCompleted = progressPercent >= 100;
          await pool.query(`
            INSERT INTO group_lesson_progress (group_id, lesson_id, progress_percent, is_completed, last_session_id)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (group_id, lesson_id) DO UPDATE
              SET progress_percent = GREATEST(group_lesson_progress.progress_percent, $3),
                  is_completed     = group_lesson_progress.is_completed OR $4,
                  last_session_id  = $5,
                  updated_at       = NOW()
          `, [group_id, lesson_id, progressPercent, isCompleted, sessionId]);
        }
      } catch (progErr) {
        // Non-fatal вЂ” session is still ended, just log
        console.error('Error saving lesson progress:', progErr);
      }
    }

    void analyzeGrammarForSession(sessionId).catch(error => console.error('DeepSeek grammar analysis failed:', error));
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error ending live session:', error);
    res.status(500).json({ success: false, error: 'Failed to end session' });
  }
});

// GET /live-sessions/group/:groupId/active - Get active session for a group
app.get('/live-sessions/group/:groupId/active', async (req, res) => {
  try {
    const { groupId } = req.params;

    const result = await pool.query(
      'SELECT * FROM live_sessions WHERE group_id = $1 AND status = $2 ORDER BY started_at DESC LIMIT 1',
      [groupId, 'active']
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, data: null });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching active session:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch active session' });
  }
});

// PUT /live-sessions/:sessionId - Update session (e.g., change step)
app.put('/live-sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { currentStepIndex } = req.body;

    if (currentStepIndex === undefined) {
      return res.status(400).json({ success: false, error: 'currentStepIndex is required' });
    }

    const result = await pool.query(`
      UPDATE live_sessions
      SET current_step_index = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [currentStepIndex, sessionId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error updating live session:', error);
    res.status(500).json({ success: false, error: 'Failed to update live session' });
  }
});

// POST /live-sessions/:sessionId/complete - Complete session
app.post('/live-sessions/:sessionId/complete', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const result = await pool.query(`
      UPDATE live_sessions
      SET status = 'completed', completed_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [sessionId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    void analyzeGrammarForSession(sessionId).catch(error => console.error('DeepSeek grammar analysis failed:', error));
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error completing live session:', error);
    res.status(500).json({ success: false, error: 'Failed to complete live session' });
  }
});

// ==================== END LIVE SESSIONS ENDPOINTS ====================

// ========== SPOTLIGHT RESULTS ==========

// POST /spotlight/results - student submits exercise results
app.post('/spotlight/results', async (req, res) => {
  try {
    const { lessonId, activityId, sessionId, studentId, studentName, results, score, total } = req.body;

    if (!lessonId || !studentName || !results || total === undefined) {
      return res.status(400).json({ success: false, error: 'lessonId, studentName, results and total are required' });
    }

    const isHskResult = results?.source === 'hsk3' || results?.source === 'hsk3-lesson1';
    if (isHskResult && activityId) {
      await pool.query(
        `DELETE FROM spotlight_results
         WHERE session_id IS NOT DISTINCT FROM $1 AND activity_id = $2
           AND (student_id = $3 OR (student_id IS NULL AND student_name = $4))`,
        [sessionId || null, activityId, studentId || null, studentName]
      );
      await ensureGrammarTables();
      await pool.query(
        `DELETE FROM student_grammar_mistakes
         WHERE session_id IS NOT DISTINCT FROM $1 AND activity_id = $2
           AND (student_id = $3 OR (student_id IS NULL AND student_name = $4))`,
        [sessionId || null, activityId, studentId || null, studentName]
      );
    }

    const row = await pool.query(`
      INSERT INTO spotlight_results (lesson_id, activity_id, session_id, student_id, student_name, results, score, total)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [lessonId, activityId || null, sessionId || null, studentId || null, studentName,
        JSON.stringify(results), score || 0, total]);

    const activity = activityId
      ? await pool.query('SELECT title FROM lesson_activities WHERE id = $1', [activityId])
      : { rows: [] };
    const grammarMistakesSaved = await saveWrittenGrammarMistakes({
      studentId, studentName, lessonId, sessionId, activityId,
      topic: activity.rows[0]?.title || 'Grammar', results,
    });

    res.status(201).json({ success: true, data: row.rows[0], grammarMistakesSaved });
  } catch (error) {
    console.error('Error saving spotlight results:', error);
    res.status(500).json({ success: false, error: 'Failed to save results' });
  }
});

// GET /spotlight/results/:lessonId - teacher gets all student results for a lesson
app.get('/spotlight/results/:lessonId', async (req, res) => {
  try {
    const { lessonId } = req.params;
    const { activityId, sessionId } = req.query;

    let query = `
      SELECT * FROM spotlight_results
      WHERE lesson_id = $1
    `;
    const params: any[] = [lessonId];

    if (activityId) {
      params.push(activityId);
      query += ` AND activity_id = $${params.length}`;
    }
    if (sessionId) {
      params.push(sessionId);
      query += ` AND session_id = $${params.length}`;
    }

    query += ' ORDER BY submitted_at DESC';

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching spotlight results:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch results' });
  }
});

// GET /spotlight/session-all-results - teacher gets every student's results for a session
app.get('/spotlight/session-all-results', async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId required' });
    }
    const result = await pool.query(
      `SELECT sr.*, la.title as activity_title, la.order_index
       FROM spotlight_results sr
       LEFT JOIN lesson_activities la ON la.id = sr.activity_id
       WHERE sr.session_id = $1
       ORDER BY la.order_index ASC, sr.submitted_at ASC`,
      [sessionId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching session results for teacher:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch results' });
  }
});

// GET /spotlight/session-results - get one student's results for a session
app.get('/spotlight/session-results', async (req, res) => {
  try {
    const { sessionId, studentId } = req.query;
    if (!sessionId || !studentId) {
      return res.status(400).json({ success: false, error: 'sessionId and studentId required' });
    }
    const result = await pool.query(
      `SELECT sr.*, la.title as activity_title, la.order_index
       FROM spotlight_results sr
       LEFT JOIN lesson_activities la ON la.id = sr.activity_id
       WHERE sr.session_id = $1 AND sr.student_id = $2
       ORDER BY la.order_index ASC, sr.submitted_at ASC`,
      [sessionId, studentId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching student session results:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch results' });
  }
});
// GET /spotlight/grammar-profile/:studentId - accumulated written mistakes and analyses
app.get('/spotlight/grammar-profile/:studentId', async (req, res) => {
  try {
    await ensureGrammarTables();
    const { studentId } = req.params;
    const mistakes = await pool.query(
      `SELECT id, lesson_id, session_id, activity_id, topic, prompt, student_answer, correct_answer, created_at
       FROM student_grammar_mistakes WHERE student_id = $1 ORDER BY created_at DESC`, [studentId]
    );
    const analyses = await pool.query(
      `SELECT id, lesson_id, session_id, lesson_mistakes, analysis_text, created_at
       FROM student_grammar_analyses WHERE student_id = $1 ORDER BY created_at DESC`, [studentId]
    );
    res.json({ success: true, data: { mistakes: mistakes.rows, analyses: analyses.rows } });
  } catch (error) {
    console.error('Error fetching grammar profile:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch grammar profile' });
  }
});

// POST /spotlight/grammar-analysis - rerun analysis for one completed lesson session
app.post('/spotlight/grammar-analysis', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId required' });
    await analyzeGrammarForSession(sessionId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error analyzing grammar:', error);
    res.status(502).json({ success: false, error: 'Failed to analyze grammar mistakes' });
  }
});

// POST /spotlight/grammar-exercises - create exactly 10 tasks from a student's diagnosed gaps
app.post('/spotlight/grammar-exercises', async (req, res) => {
  try {
    await ensureGrammarTables();
    const { studentId, sessionId } = req.body;
    if (!studentId) return res.status(400).json({ success: false, error: 'studentId required' });
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ success: false, error: 'DeepSeek is not configured' });

    const analysis = await pool.query(
      `SELECT id, analysis_text FROM student_grammar_analyses
       WHERE student_id = $1 AND ($2::uuid IS NULL OR session_id = $2)
       ORDER BY created_at DESC LIMIT 1`, [studentId, sessionId || null]
    );
    const mistakes = await pool.query(
      `SELECT lesson_id, topic, prompt, student_answer, correct_answer
       FROM student_grammar_mistakes WHERE student_id = $1 ORDER BY created_at DESC LIMIT 100`, [studentId]
    );
    if (!mistakes.rows.length) {
      return res.status(400).json({ success: false, error: 'РЈ СѓС‡РµРЅРёРєР° РїРѕРєР° РЅРµС‚ СЃРѕС…СЂР°РЅС‘РЅРЅС‹С… РїРёСЃСЊРјРµРЅРЅС‹С… РіСЂР°РјРјР°С‚РёС‡РµСЃРєРёС… РѕС€РёР±РѕРє' });
    }

    const aiResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat', temperature: 0.55, max_tokens: 1800,
        messages: [
          { role: 'system', content: 'РЎРѕСЃС‚Р°РІСЊ Р РћР’РќРћ 10 Р·Р°РґР°РЅРёР№ РїРѕ РІСЃРµРј С‚РµРјР°Рј priorities Рё teacherSummary. Р•СЃР»Рё СѓРїРѕРјСЏРЅСѓС‚С‹ РѕС‚СЂРёС†Р°РЅРёСЏ, РјРёРЅРёРјСѓРј 4 Р·Р°РґР°РЅРёСЏ РґРѕР»Р¶РЅС‹ С‚СЂРµР±РѕРІР°С‚СЊ am not/isnвЂ™t/arenвЂ™t. РљРђР–Р”РћР• Р·Р°РґР°РЅРёРµ СЃ РѕС‚СЂРёС†Р°С‚РµР»СЊРЅС‹Рј РѕС‚РІРµС‚РѕРј РѕР±СЏР·Р°РЅРѕ СЃРѕРґРµСЂР¶Р°С‚СЊ РІС‚РѕСЂРѕРµ РєРѕСЂРѕС‚РєРѕРµ РїСЂРµРґР»РѕР¶РµРЅРёРµ СЃ С‚РµРј Р¶Рµ РїРѕРґР»РµР¶Р°С‰РёРј, РєРѕС‚РѕСЂРѕРµ РѕРґРЅРѕР·РЅР°С‡РЅРѕ РїРѕРєР°Р·С‹РІР°РµС‚ РїСЂРѕС‚РёРІРѕРїРѕСЃС‚Р°РІР»РµРЅРёРµ, РЅР°РїСЂРёРјРµСЂ: {"sentence":"I ______ a teacher. I am a student.","answer":"am not"}. РќРµР»СЊР·СЏ СЃРѕР·РґР°РІР°С‚СЊ РЅРµРѕРґРЅРѕР·РЅР°С‡РЅРѕРµ РѕС‚СЂРёС†Р°С‚РµР»СЊРЅРѕРµ Р·Р°РґР°РЅРёРµ РІСЂРѕРґРµ "I ______ a teacher." Р±РµР· РєРѕРЅС‚РµРєСЃС‚Р°. Р•СЃР»Рё СѓРїРѕРјСЏРЅСѓС‚С‹ РІРѕРїСЂРѕСЃС‹, РґРѕР±Р°РІСЊ РјРёРЅРёРјСѓРј 2 РІРѕРїСЂРѕСЃР°. Р’РµСЂРЅРё РўРћР›Р¬РљРћ JSON-РјР°СЃСЃРёРІ Р±РµР· markdown. Р’ РєР°Р¶РґРѕРј РѕР±СЉРµРєС‚Рµ С‚РѕР»СЊРєРѕ sentence Рё answer. РћРґРёРЅ РїСЂРѕРїСѓСЃРє ______. РћС‚РІРµС‚ РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ С‚РѕС‡РЅС‹Рј С‚РµРєСЃС‚РѕРј РґР»СЏ Р°РІС‚РѕРїСЂРѕРІРµСЂРєРё.' },
          { role: 'user', content: JSON.stringify({ analysis: analysis.rows[0]?.analysis_text || null, accumulatedMistakes: mistakes.rows }) },
        ],
      }),
    });
    if (!aiResponse.ok) throw new Error(`DeepSeek API returned ${aiResponse.status}: ${await aiResponse.text()}`);
    const aiData: any = await aiResponse.json();
    const rawGenerated = String(aiData.choices?.[0]?.message?.content || '').replace(/^```json\s*|```$/g, '').trim();
    const tasks = JSON.parse(rawGenerated);
    if (!Array.isArray(tasks) || tasks.length !== 10 || tasks.some((task: any) => !task?.sentence || !task?.answer)) {
      throw new Error('DeepSeek returned invalid homework JSON');
    }
    const generatedText = JSON.stringify(tasks.map((task: any) => ({
      sentence: String(task.sentence),
      answer: String(task.answer),
    })));
    const saved = await pool.query(`
      INSERT INTO student_grammar_exercise_sets
        (student_id, session_id, source_analysis_id, exercise_count, generated_text)
      VALUES ($1,$2,$3,10,$4) RETURNING id, generated_text, created_at
    `, [studentId, sessionId || null, analysis.rows[0]?.id || null, generatedText]);
    res.json({ success: true, data: saved.rows[0] });
  } catch (error) {
    console.error('Error generating grammar exercises:', error);
    res.status(502).json({ success: false, error: 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕСЃС‚Р°РІРёС‚СЊ СѓРїСЂР°Р¶РЅРµРЅРёСЏ' });
  }
});

app.get('/students/:id/homework', async (req, res) => {
  try {
    await ensureGrammarTables();
    const result = await pool.query(
      `SELECT id, generated_text, student_answers, score, completed_at, created_at
       FROM student_grammar_exercise_sets
       WHERE student_id = $1 AND completed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.json({ success: true, data: null });
    const row = result.rows[0];
    const tasks = JSON.parse(row.generated_text);
    const answers = Array.isArray(row.student_answers) ? row.student_answers : [];
    const normalize = (value: any) => String(value || '').trim().toLowerCase().replace(/[вЂ™вЂ]/g, "'");
    const checks = row.completed_at
      ? tasks.map((task: any, index: number) => normalize(answers[index]) === normalize(task.answer))
      : null;
    res.json({
      success: true,
      data: {
        id: row.id,
        tasks: tasks.map((task: any, index: number) => ({ index, sentence: task.sentence })),
        score: row.score,
        answers,
        checks,
        total: tasks.length,
        completedAt: row.completed_at,
        createdAt: row.created_at,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to load homework' });
  }
});

app.post('/students/:id/homework/:homeworkId/submit', async (req, res) => {
  try {
    await ensureGrammarTables();
    const result = await pool.query(
      `SELECT generated_text FROM student_grammar_exercise_sets WHERE id = $1 AND student_id = $2`,
      [req.params.homeworkId, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Homework not found' });
    const tasks = JSON.parse(result.rows[0].generated_text);
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const normalize = (value: any) => String(value || '').trim().toLowerCase().replace(/[вЂ™вЂ]/g, "'");
    const checks = tasks.map((task: any, index: number) => normalize(answers[index]) === normalize(task.answer));
    const score = checks.filter(Boolean).length;
    await pool.query(
      `UPDATE student_grammar_exercise_sets
       SET student_answers = $1, score = $2, completed_at = NOW() WHERE id = $3`,
      [JSON.stringify(answers), score, req.params.homeworkId]
    );
    res.json({ success: true, data: { score, total: tasks.length, checks } });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to check homework' });
  }
});

// POST /spotlight/practice-exercise - generate AI practice exercises from a student's mistakes
app.post('/spotlight/practice-exercise', async (req, res) => {
  try {
    const { sessionId, studentId } = req.body;
    if (!sessionId || !studentId) {
      return res.status(400).json({ success: false, error: 'sessionId and studentId required' });
    }

    // Serve cached result if we already generated one for this session+student
    const cached = await pool.query(
      'SELECT generated_text, created_at FROM practice_exercises WHERE session_id = $1 AND student_id = $2 ORDER BY created_at DESC LIMIT 1',
      [sessionId, studentId]
    );
    if (cached.rows.length > 0) {
      return res.json({ success: true, data: { generatedText: cached.rows[0].generated_text, cached: true } });
    }

    const resultsQuery = await pool.query(
      `SELECT sr.*, la.title as activity_title
       FROM spotlight_results sr
       LEFT JOIN lesson_activities la ON la.id = sr.activity_id
       WHERE sr.session_id = $1 AND sr.student_id = $2`,
      [sessionId, studentId]
    );

    const mistakes: Array<{ topic: string; sentence?: string; correctAnswer?: string; studentAnswer?: string }> = [];
    for (const row of resultsQuery.rows) {
      const details = Array.isArray(row.results) ? row.results : [];
      for (const d of details) {
        if (d && d.isCorrect === false) {
          mistakes.push({
            topic: row.activity_title || 'Grammar',
            sentence: d.sentence,
            correctAnswer: d.correctAnswer,
            studentAnswer: d.studentAnswer,
          });
        }
      }
    }

    if (mistakes.length === 0) {
      return res.json({ success: true, data: { generatedText: 'РћС€РёР±РѕРє РЅРµС‚ вЂ” СѓС‡РµРЅРёРє РїСЂРѕС€С‘Р» СѓРїСЂР°Р¶РЅРµРЅРёСЏ Р±РµР· РѕС€РёР±РѕРє, РґРѕРїРѕР»РЅРёС‚РµР»СЊРЅР°СЏ С‚СЂРµРЅРёСЂРѕРІРєР° РЅРµ С‚СЂРµР±СѓРµС‚СЃСЏ. рџЋ‰', noErrors: true } });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ success: false, error: 'OPENAI_API_KEY is not configured on the server' });
    }

    const mistakesLines = mistakes.map((m, i) => {
      const correct = m.sentence || m.correctAnswer || '';
      return (i + 1) + '. Topic: ' + m.topic + '. Correct: "' + correct + '". Student wrote: "' + m.studentAnswer + '"';
    });
    const mistakesList = mistakesLines.join('\n');

    const systemPrompt = [
      'You are an assistant for a children English teacher.',
      'Given a list of a specific student mistakes (grammar topic, the correct sentence, and what the student wrote instead),',
      'write 5 new short practice sentences or fill-in-the-blank tasks targeting the SAME grammar points',
      '(do not reuse the exact same sentences). Keep vocabulary simple, suitable for a child learning English.',
      'After the English exercises, add one short sentence in Russian for the teacher explaining what grammar point this practices.',
      'Format the output as a numbered list.',
    ].join(' ');

    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        max_tokens: 700,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Student mistakes this lesson:\n' + mistakesList + '\n\nGenerate 5 new practice tasks for this student.' },
        ],
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error('OpenAI API error:', aiResponse.status, errText);
      return res.status(502).json({ success: false, error: 'Failed to generate practice exercise' });
    }

    const aiData: any = await aiResponse.json();
    const generatedText = aiData.choices?.[0]?.message?.content || '';

    const studentName = resultsQuery.rows[0]?.student_name || 'РЈС‡РµРЅРёРє';
    const lessonId = resultsQuery.rows[0]?.lesson_id || null;

    await pool.query(
      `INSERT INTO practice_exercises (session_id, student_id, student_name, lesson_id, source_errors, generated_text)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, studentId, studentName, lessonId, JSON.stringify(mistakes), generatedText]
    );

    res.json({ success: true, data: { generatedText, cached: false } });
  } catch (error) {
    console.error('Error generating practice exercise:', error);
    res.status(500).json({ success: false, error: 'Failed to generate practice exercise' });
  }
});

// ==================== END SPOTLIGHT RESULTS ====================

// Setup WebSocket
const http = require('http');
const httpServer = http.createServer(app);
const { setupWebSocket } = require('./websocket-server');

// Only start listening + setting up websocket when run as the main module
// (so supertest can import the express app without binding to a port)
if (require.main === module) {
  setupWebSocket(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`рџљЂ Kids English Backend running on port ${PORT}`);
  });

  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing database pool');
    await pool.end();
    process.exit(0);
  });
}

module.exports = { app, pool };
