import { LessonSession, StudentState, Session } from '../types';
import { redisClient } from '../config/database';
import logger from '../utils/logger';

export class SessionManager {
  private sessions: Map<string, LessonSession> = new Map();

  // Get or create session
  async getSession(sessionId: string, session: Session): Promise<LessonSession> {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    // Try to restore from Redis
    const cached = await this.loadFromRedis(sessionId);
    if (cached) {
      this.sessions.set(sessionId, cached);
      return cached;
    }

    // Create new
    const lessonSession: LessonSession = {
      sessionId,
      session,
      students: new Map(),
    };

    this.sessions.set(sessionId, lessonSession);
    await this.saveToRedis(lessonSession);
    return lessonSession;
  }

  // Add student to session
  async addStudent(sessionId: string, student: StudentState): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    session.students.set(student.studentId, student);
    await this.saveToRedis(session);
    logger.info(`Student ${student.displayName} joined session ${sessionId}`);
  }

  // Remove student from session
  async removeStudent(sessionId: string, studentId: string): Promise<StudentState | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const student = session.students.get(studentId);
    session.students.delete(studentId);
    await this.saveToRedis(session);

    // Clean up empty sessions
    if (session.students.size === 0) {
      this.sessions.delete(sessionId);
      await redisClient.del(`session:${sessionId}`);
      logger.info(`Session ${sessionId} cleaned up (no students)`);
    }

    return student;
  }

  // Update student progress
  async updateStudentProgress(
    sessionId: string,
    studentId: string,
    activityId: string,
    points: number
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const student = session.students.get(studentId);
    if (!student) {
      throw new Error('Student not found in session');
    }

    // Update activity progress
    if (!student.activityProgress[activityId]) {
      student.activityProgress[activityId] = {
        status: 'active',
        earnedPoints: 0,
      };
    }

    student.activityProgress[activityId].earnedPoints += points;
    student.totalPoints += points;

    await this.saveToRedis(session);
  }

  // Get all students in session
  getStudents(sessionId: string): StudentState[] {
    const session = this.sessions.get(sessionId);
    return session ? Array.from(session.students.values()) : [];
  }

  // Save to Redis for persistence
  private async saveToRedis(session: LessonSession): Promise<void> {
    try {
      const data = {
        sessionId: session.sessionId,
        session: session.session,
        students: Array.from(session.students.entries()),
      };
      await redisClient.setEx(`session:${session.sessionId}`, 86400, JSON.stringify(data)); // 24h TTL
    } catch (error) {
      logger.error('Failed to save session to Redis:', error);
    }
  }

  // Load from Redis
  private async loadFromRedis(sessionId: string): Promise<LessonSession | null> {
    try {
      const data = await redisClient.get(`session:${sessionId}`);
      if (!data) return null;

      const parsed = JSON.parse(data);
      return {
        sessionId: parsed.sessionId,
        session: parsed.session,
        students: new Map(parsed.students),
      };
    } catch (error) {
      logger.error('Failed to load session from Redis:', error);
      return null;
    }
  }

  // Cleanup expired sessions
  async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (new Date(session.session.expiresAt).getTime() < now) {
        this.sessions.delete(sessionId);
        await redisClient.del(`session:${sessionId}`);
        logger.info(`Expired session ${sessionId} removed`);
      }
    }
  }
}

export const sessionManager = new SessionManager();
