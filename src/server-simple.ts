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

// Middleware
app.use(cors());
// Activities (esp. snake/letter games) embed images as base64 — bump body limit from default 100kb
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

    // Get activities for this lesson
    const activities = await pool.query(
      'SELECT * FROM lesson_activities WHERE lesson_id = $1 ORDER BY order_index',
      [id]
    );

    res.json({
      success: true,
      data: {
        ...result.rows[0],
        activities: activities.rows
      }
    });
  } catch (error) {
    console.error('Error fetching lesson:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch lesson' });
  }
});

// POST /lessons - Create new lesson
app.post('/lessons', async (req, res) => {
  try {
    const { title, description, islandId, emoji, courseId } = req.body;

    // Auto-assign next order_index for this island
    const maxOrderResult = await pool.query(
      'SELECT COALESCE(MAX(order_index), 0) as max FROM lessons WHERE island_id = $1',
      [islandId || null]
    );
    const nextOrder = (maxOrderResult.rows[0].max || 0) + 1;

    const result = await pool.query(`
      INSERT INTO lessons (title, description, island_id, emoji, status, order_index, course_id)
      VALUES ($1, $2, $3, $4, 'draft', $5, $6)
      RETURNING *
    `, [title, description || null, islandId || null, emoji || '🏝️', nextOrder, courseId || null]);

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
    const { title, description, status, unit_number } = req.body;

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
app.get('/lessons/:lessonId/activities', async (req, res) => {
  try {
    const { lessonId } = req.params;

    const result = await pool.query(
      'SELECT * FROM lesson_activities WHERE lesson_id = $1 ORDER BY order_index',
      [lessonId]
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch activities' });
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
// (must come before /:activityId route — Express matches in registration order)
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
          content_data = COALESCE($5, content_data),
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

    // If user has a password — verify it
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

// GET /courses - Get all courses for a teacher
app.get('/courses', async (req, res) => {
  try {
    const { teacherId } = req.query;

    if (!teacherId) {
      return res.status(400).json({ success: false, error: 'Teacher ID is required' });
    }

    const result = await pool.query(`
      SELECT * FROM courses
      WHERE teacher_id = $1
      ORDER BY created_at DESC
    `, [teacherId]);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch courses' });
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
    `, [name, teacherId, description || '', emoji || '📚']);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error creating course:', error);
    res.status(500).json({ success: false, error: 'Failed to create course' });
  }
});

// GET /courses/:id/groups - Get groups assigned to a course with progress
app.get('/courses/:id/groups', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT g.*,
             gc.current_lesson_id,
             l.title as current_lesson_title
      FROM groups g
      INNER JOIN group_courses gc ON g.id = gc.group_id
      LEFT JOIN lessons l ON gc.current_lesson_id = l.id
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

    // For now, just return lessons for this group without progress data
    // since group_lesson_progress table doesn't exist yet
    const result = await pool.query(`
      SELECT
        l.id as lesson_id,
        l.title as lesson_title,
        l.island_id,
        l.order_index
      FROM lessons l
      WHERE l.group_id = $1
      ORDER BY l.island_id, l.order_index
    `, [id]);

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

// POST /students - Create a new student
app.post('/students', async (req, res) => {
  console.log("[DEBUG] POST /students called with body:", req.body);
  try {
    const { groupId, studentName, login, password } = req.body;

    if (!groupId || !studentName || !login || !password) {
      return res.status(400).json({
        success: false,
        error: 'Group ID, student name, login and password are required'
      });
    }

    // Check if login already exists
    const existingStudent = await pool.query(
      'SELECT * FROM students WHERE login = $1',
      [login]
    );

    if (existingStudent.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Логин "${login}" уже используется`
      });
    }

    // Hash password
    const bcrypt = require('bcrypt');
    const passwordHash = await bcrypt.hash(password, 10);

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

    res.status(201).json({ success: true, data: studentResult.rows[0] });
  } catch (error) {
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
    res.json({ success: true, data: result.rows[0] });
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
    const result = await pool.query(
      'UPDATE students SET points = $1 WHERE id = $2 RETURNING id, student_name, points, group_id',
      [points, studentId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }
    res.json({ success: true, data: result.rows[0] });
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
          error: `Логин "${loginValue}" уже используется другим учеником`
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
      return res.status(404).json({ success: false, error: 'Неверный логин или пароль' });
    }

    const student = result.rows[0];

    // Verify password
    const bcrypt = require('bcrypt');
    const passwordMatch = await bcrypt.compare(password, student.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ success: false, error: 'Неверный логин или пароль' });
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

    // Check if there's already an active session for this group
    const existing = await pool.query(
      'SELECT id FROM live_sessions WHERE group_id = $1 AND status = $2',
      [groupId, 'active']
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Group already has an active session',
        sessionId: existing.rows[0].id
      });
    }

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
      'SELECT *, current_step_index AS current_activity_index FROM live_sessions WHERE id = $1',
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
      score, status, timeSeconds, details,
    } = req.body;

    if (!activityId) {
      return res.status(400).json({ success: false, error: 'activityId is required' });
    }

    // UPSERT — one row per (session, activity, student)
    const result = await pool.query(
      `INSERT INTO activity_results
         (session_id, lesson_id, activity_id, student_id, student_name, score, status, time_seconds, details, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (session_id, activity_id, student_id) DO UPDATE
       SET score = EXCLUDED.score,
           status = EXCLUDED.status,
           time_seconds = EXCLUDED.time_seconds,
           details = EXCLUDED.details,
           student_name = EXCLUDED.student_name,
           updated_at = NOW()
       RETURNING *`,
      [sessionId === 'none' ? null : sessionId, lessonId || null, activityId,
       studentId || null, studentName || null,
       score || 0, status || 'completed', timeSeconds || null,
       details ? JSON.stringify(details) : null]
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

    const row = await pool.query(`
      INSERT INTO spotlight_results (lesson_id, activity_id, session_id, student_id, student_name, results, score, total)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [lessonId, activityId || null, sessionId || null, studentId || null, studentName,
        JSON.stringify(results), score || 0, total]);

    res.status(201).json({ success: true, data: row.rows[0] });
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
    console.log(`🚀 Kids English Backend running on port ${PORT}`);
  });

  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing database pool');
    await pool.end();
    process.exit(0);
  });
}

module.exports = { app, pool };
