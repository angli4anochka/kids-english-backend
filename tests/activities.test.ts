import request from 'supertest';
import { getTestPool, closeTestPool, truncateAll, createTestLesson, createTestActivity } from './helpers';

const { app } = require('../src/server-simple');

describe('Activities endpoints', () => {
  beforeAll(async () => { await truncateAll(); });
  afterAll(async () => { await closeTestPool(); });

  describe('POST /lessons/:lessonId/activities', () => {
    it('creates a new activity and returns it with a UUID', async () => {
      const lesson = await createTestLesson();
      const res = await request(app)
        .post(`/lessons/${lesson.id}/activities`)
        .send({ type: 'image', title: 'A', subtitle: 'sub', points: 5 });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.type).toBe('image');
      expect(res.body.title).toBe('A');
      expect(res.body.points).toBe(5);
    });

    it('assigns incrementing order_index per lesson', async () => {
      const lesson = await createTestLesson();
      const a1 = await request(app).post(`/lessons/${lesson.id}/activities`).send({ type: 'image', title: '1' });
      const a2 = await request(app).post(`/lessons/${lesson.id}/activities`).send({ type: 'image', title: '2' });
      expect(a2.body.order_index).toBeGreaterThan(a1.body.order_index);
    });

    it('persists contentData as JSONB', async () => {
      const lesson = await createTestLesson();
      const res = await request(app)
        .post(`/lessons/${lesson.id}/activities`)
        .send({ type: 'snake-word', title: 'Snake', contentData: { snakeWordConfig: { words: ['CAT', 'DOG'] } } });
      expect(res.status).toBe(201);
      const pool = getTestPool();
      const row = await pool.query('SELECT content_data FROM lesson_activities WHERE id = $1', [res.body.id]);
      expect(row.rows[0].content_data.snakeWordConfig.words).toEqual(['CAT', 'DOG']);
    });
  });

  describe('PUT /lessons/:lessonId/activities/:activityId', () => {
    it('updates an existing activity', async () => {
      const lesson = await createTestLesson();
      const a = await createTestActivity(lesson.id);
      const res = await request(app)
        .put(`/lessons/${lesson.id}/activities/${a.id}`)
        .send({ title: 'Updated title', points: 99 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('Updated title');
      expect(res.body.data.points).toBe(99);
    });

    it('preserves fields not provided (COALESCE)', async () => {
      const lesson = await createTestLesson();
      const a = await createTestActivity(lesson.id);
      await request(app).put(`/lessons/${lesson.id}/activities/${a.id}`).send({ title: 'First' });
      const res = await request(app).put(`/lessons/${lesson.id}/activities/${a.id}`).send({ points: 50 });
      expect(res.body.data.title).toBe('First'); // not lost
      expect(res.body.data.points).toBe(50);
    });

    it('returns 404 for non-existent activity (with valid UUID)', async () => {
      const lesson = await createTestLesson();
      const res = await request(app)
        .put(`/lessons/${lesson.id}/activities/00000000-0000-0000-0000-000000000000`)
        .send({ title: 'X' });
      expect(res.status).toBe(404);
    });

    it('returns 500 on invalid UUID (caught from pg)', async () => {
      const lesson = await createTestLesson();
      const res = await request(app)
        .put(`/lessons/${lesson.id}/activities/not-a-uuid`)
        .send({ title: 'X' });
      expect(res.status).toBe(500);
    });
  });

  describe('PUT /lessons/:lessonId/activities/reorder', () => {
    it('reorders activities according to provided id array', async () => {
      const lesson = await createTestLesson();
      const a = await createTestActivity(lesson.id);
      const b = await createTestActivity(lesson.id);
      const c = await createTestActivity(lesson.id);

      const res = await request(app)
        .put(`/lessons/${lesson.id}/activities/reorder`)
        .send({ activityIds: [c.id, a.id, b.id] });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const pool = getTestPool();
      const rows = await pool.query(
        'SELECT id, order_index FROM lesson_activities WHERE lesson_id = $1 ORDER BY order_index',
        [lesson.id]
      );
      expect(rows.rows.map((r: any) => r.id)).toEqual([c.id, a.id, b.id]);
    });

    it('rejects empty array with 400', async () => {
      const lesson = await createTestLesson();
      const res = await request(app)
        .put(`/lessons/${lesson.id}/activities/reorder`)
        .send({ activityIds: [] });
      expect(res.status).toBe(400);
    });

    it('does not match the :activityId update route', async () => {
      // The reorder route must be registered BEFORE /:activityId,
      // otherwise "reorder" would be interpreted as an activityId.
      const lesson = await createTestLesson();
      const res = await request(app)
        .put(`/lessons/${lesson.id}/activities/reorder`)
        .send({ activityIds: ['00000000-0000-0000-0000-000000000000'] });
      // Should hit reorder handler (which accepts any id) → 200, not 404 "Activity not found"
      expect(res.status).toBe(200);
    });
  });

  describe('DELETE /lessons/:lessonId/activities/:activityId', () => {
    it('removes the activity', async () => {
      const lesson = await createTestLesson();
      const a = await createTestActivity(lesson.id);
      const res = await request(app).delete(`/lessons/${lesson.id}/activities/${a.id}`);
      expect([200, 204]).toContain(res.status);
      const pool = getTestPool();
      const after = await pool.query('SELECT id FROM lesson_activities WHERE id = $1', [a.id]);
      expect(after.rows).toHaveLength(0);
    });
  });

  describe('GET /lessons/:lessonId/activities', () => {
    it('returns activities sorted by order_index', async () => {
      const lesson = await createTestLesson();
      const a = await createTestActivity(lesson.id);
      const b = await createTestActivity(lesson.id);
      // Force b to come before a
      const pool = getTestPool();
      await pool.query('UPDATE lesson_activities SET order_index = 0 WHERE id = $1', [b.id]);
      await pool.query('UPDATE lesson_activities SET order_index = 1 WHERE id = $1', [a.id]);

      const res = await request(app).get(`/lessons/${lesson.id}/activities`);
      expect(res.status).toBe(200);
      const ids = (res.body.data || res.body).map((r: any) => r.id);
      expect(ids).toEqual([b.id, a.id]);
    });
  });
});
