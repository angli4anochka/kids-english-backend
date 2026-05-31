import request from 'supertest';
import bcrypt from 'bcrypt';
import { getTestPool, closeTestPool, truncateAll, createTestUser, createTestGroup } from './helpers';

const { app } = require('../src/server-simple');

describe('Auth endpoints', () => {
  beforeAll(async () => { await truncateAll(); });
  afterAll(async () => { await closeTestPool(); });

  describe('POST /auth/register', () => {
    it('creates a teacher account and returns a token + user payload', async () => {
      const email = `reg-${Date.now()}@test.local`;
      const res = await request(app).post('/auth/register').send({
        email,
        displayName: 'Mr. Smith',
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('token');
      expect(res.body.data.user).toMatchObject({
        email,
        displayName: 'Mr. Smith',
        role: 'teacher',
      });
      expect(res.body.data.user).toHaveProperty('id');
    });

    it('rejects when email or displayName missing', async () => {
      let res = await request(app).post('/auth/register').send({ email: 'x@y.z' });
      expect(res.status).toBe(400);
      res = await request(app).post('/auth/register').send({ displayName: 'X' });
      expect(res.status).toBe(400);
    });

    it('rejects duplicate email', async () => {
      const email = `dup-${Date.now()}@test.local`;
      await request(app).post('/auth/register').send({ email, displayName: 'A' });
      const res = await request(app).post('/auth/register').send({ email, displayName: 'B' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/exists/i);
    });
  });

  describe('POST /auth/login', () => {
    it('logs in an existing user by email and returns a token', async () => {
      const user = await createTestUser();
      const res = await request(app).post('/auth/login').send({ email: user.email });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('token');
      expect(res.body.data.user.id).toBe(user.id);
    });

    it('returns 404 for unknown email', async () => {
      const res = await request(app).post('/auth/login').send({ email: 'nobody-here@test.local' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /auth/student-login', () => {
    async function createStudent(login: string, password: string) {
      const teacher = await createTestUser({ role: 'teacher' });
      const group = await createTestGroup(teacher.id);
      const hash = await bcrypt.hash(password, 4);
      const pool = getTestPool();
      const r = await pool.query(
        `INSERT INTO students (group_id, student_name, login, password_hash)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [group.id, 'Petya', login, hash]
      );
      return { id: r.rows[0].id, groupId: group.id };
    }

    it('logs in a student with correct password and returns groupId', async () => {
      const login = `petya-${Date.now()}`;
      const s = await createStudent(login, 'secret-123');
      const res = await request(app).post('/auth/student-login').send({ login, password: 'secret-123' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user).toMatchObject({
        role: 'student',
        groupId: s.groupId,
        displayName: 'Petya',
      });
      expect(res.body.data.user.id).toBe(String(s.id));
    });

    it('returns 401 for wrong password', async () => {
      const login = `wrong-${Date.now()}`;
      await createStudent(login, 'right-pass');
      const res = await request(app).post('/auth/student-login').send({ login, password: 'WRONG' });
      expect(res.status).toBe(401);
    });

    it('returns 404 for unknown login', async () => {
      const res = await request(app).post('/auth/student-login').send({ login: 'ghost-x', password: 'x' });
      expect(res.status).toBe(404);
    });

    it('rejects empty body with 400', async () => {
      const res = await request(app).post('/auth/student-login').send({});
      expect(res.status).toBe(400);
    });
  });
});
