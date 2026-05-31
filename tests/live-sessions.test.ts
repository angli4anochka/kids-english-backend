import request from 'supertest';
import { getTestPool, closeTestPool, truncateAll, createTestUser, createTestGroup, createTestLesson, createTestActivity } from './helpers';

const { app } = require('../src/server-simple');

describe('Live sessions endpoints', () => {
  beforeAll(async () => { await truncateAll(); });
  afterAll(async () => { await closeTestPool(); });

  async function setupSession() {
    const teacher = await createTestUser({ role: 'teacher' });
    const group = await createTestGroup(teacher.id);
    const lesson = await createTestLesson({ groupId: group.id });
    const res = await request(app).post('/live-sessions').send({
      lessonId: lesson.id,
      groupId: group.id,
      teacherId: teacher.id,
    });
    return { teacher, group, lesson, session: res.body.data };
  }

  describe('POST /live-sessions', () => {
    it('creates a new active session with current_step_index=0', async () => {
      const teacher = await createTestUser({ role: 'teacher' });
      const group = await createTestGroup(teacher.id);
      const lesson = await createTestLesson({ groupId: group.id });

      const res = await request(app).post('/live-sessions').send({
        lessonId: lesson.id,
        groupId: group.id,
        teacherId: teacher.id,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.current_step_index).toBe(0);
    });

    it('rejects missing fields with 400', async () => {
      const res = await request(app).post('/live-sessions').send({});
      expect(res.status).toBe(400);
    });

    it('rejects duplicate active session for the same group', async () => {
      const { lesson, group, teacher } = await setupSession();
      const res = await request(app).post('/live-sessions').send({
        lessonId: lesson.id,
        groupId: group.id,
        teacherId: teacher.id,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/active session/i);
    });
  });

  describe('GET /live-sessions/:sessionId', () => {
    it('returns the session with current_activity_index alias', async () => {
      const { session } = await setupSession();
      const res = await request(app).get(`/live-sessions/${session.id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Alias used by frontend: current_step_index AS current_activity_index
      expect(res.body.data.current_activity_index).toBe(0);
      expect(res.body.data.current_step_index).toBe(0);
    });

    it('returns 404 for unknown id', async () => {
      const res = await request(app).get('/live-sessions/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /live-sessions/:sessionId/activity', () => {
    it('updates current_step_index from activityIndex body', async () => {
      const { session } = await setupSession();
      const res = await request(app)
        .put(`/live-sessions/${session.id}/activity`)
        .send({ activityIndex: 3 });
      expect(res.status).toBe(200);
      expect(res.body.data.current_step_index).toBe(3);
      expect(res.body.data.current_activity_index).toBe(3);
    });

    it('rejects missing activityIndex', async () => {
      const { session } = await setupSession();
      const res = await request(app).put(`/live-sessions/${session.id}/activity`).send({});
      expect(res.status).toBe(400);
    });

    it('persists across reads (so refreshed student lands on same step)', async () => {
      const { session } = await setupSession();
      await request(app).put(`/live-sessions/${session.id}/activity`).send({ activityIndex: 5 });
      const get = await request(app).get(`/live-sessions/${session.id}`);
      expect(get.body.data.current_activity_index).toBe(5);
    });
  });

  describe('DELETE /live-sessions/:sessionId', () => {
    it('marks session as completed', async () => {
      const { session } = await setupSession();
      const del = await request(app).delete(`/live-sessions/${session.id}`);
      expect(del.status).toBe(200);
      expect(del.body.data.status).toBe('completed');
    });
  });

  describe('Results endpoints', () => {
    it('POST /live-sessions/:sessionId/results saves a new result', async () => {
      const { session, lesson } = await setupSession();
      const a = await createTestActivity(lesson.id, 'snake-word');
      const studentId = (await createTestUser({ role: 'student' })).id;
      const res = await request(app).post(`/live-sessions/${session.id}/results`).send({
        activityId: a.id,
        lessonId: lesson.id,
        studentId,
        studentName: 'Alice',
        score: 80,
        status: 'completed',
        timeSeconds: 45,
        details: { mistakes: 2 },
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.score).toBe(80);
      expect(res.body.data.student_name).toBe('Alice');
    });

    it('upserts on (session_id, activity_id, student_id) — same student replays', async () => {
      const { session, lesson } = await setupSession();
      const a = await createTestActivity(lesson.id, 'snake-word');
      const studentId = (await createTestUser({ role: 'student' })).id;

      await request(app).post(`/live-sessions/${session.id}/results`).send({
        activityId: a.id, studentId, studentName: 'Bob', score: 30, status: 'failed',
      });
      await request(app).post(`/live-sessions/${session.id}/results`).send({
        activityId: a.id, studentId, studentName: 'Bob', score: 90, status: 'completed',
      });

      const get = await request(app).get(`/live-sessions/${session.id}/results`);
      const ours = get.body.data.filter((r: any) => r.student_id === studentId && r.activity_id === a.id);
      expect(ours).toHaveLength(1); // not duplicated
      expect(ours[0].score).toBe(90); // overwritten
      expect(ours[0].status).toBe('completed');
    });

    it('rejects POST without activityId', async () => {
      const { session } = await setupSession();
      const res = await request(app).post(`/live-sessions/${session.id}/results`).send({ score: 10 });
      expect(res.status).toBe(400);
    });

    it('GET returns all results for the session, newest first', async () => {
      const { session, lesson } = await setupSession();
      const a = await createTestActivity(lesson.id, 'snake-word');
      const s1 = await createTestUser({ role: 'student' });
      const s2 = await createTestUser({ role: 'student' });

      await request(app).post(`/live-sessions/${session.id}/results`).send({
        activityId: a.id, studentId: s1.id, studentName: 'A', score: 50,
      });
      await new Promise(r => setTimeout(r, 50));
      await request(app).post(`/live-sessions/${session.id}/results`).send({
        activityId: a.id, studentId: s2.id, studentName: 'B', score: 70,
      });

      const res = await request(app).get(`/live-sessions/${session.id}/results`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
      // Newest first
      expect(new Date(res.body.data[0].created_at).getTime())
        .toBeGreaterThanOrEqual(new Date(res.body.data[1].created_at).getTime());
    });
  });
});
