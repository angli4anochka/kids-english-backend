import { pgPool } from '../config/database';
import { Session, LessonMode } from '../types';
import { v4 as uuidv4 } from 'uuid';

export class SessionModel {
  static async create(
    teacherId: string,
    islandId: number,
    mode: LessonMode = 'synchronized'
  ): Promise<Session> {
    const id = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const query = `
      INSERT INTO sessions (id, teacher_id, island_id, mode, expires_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const result = await pgPool.query(query, [id, teacherId, islandId, mode, expiresAt]);
    return this.mapRow(result.rows[0]);
  }

  static async findById(id: string): Promise<Session | null> {
    const query = 'SELECT * FROM sessions WHERE id = $1 AND expires_at > NOW()';
    const result = await pgPool.query(query, [id]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  static async findActiveByTeacher(teacherId: string): Promise<Session[]> {
    const query = `
      SELECT * FROM sessions
      WHERE teacher_id = $1
      AND status = 'active'
      AND expires_at > NOW()
      ORDER BY created_at DESC
    `;
    const result = await pgPool.query(query, [teacherId]);
    return result.rows.map(this.mapRow);
  }

  static async updateActivity(sessionId: string, activityId: string): Promise<void> {
    const query = 'UPDATE sessions SET current_activity = $1 WHERE id = $2';
    await pgPool.query(query, [activityId, sessionId]);
  }

  static async updateStatus(sessionId: string, status: 'active' | 'paused' | 'completed'): Promise<void> {
    const query = 'UPDATE sessions SET status = $1 WHERE id = $2';
    await pgPool.query(query, [status, sessionId]);
  }

  static async deleteExpired(): Promise<number> {
    const query = 'DELETE FROM sessions WHERE expires_at < NOW()';
    const result = await pgPool.query(query);
    return result.rowCount || 0;
  }

  private static mapRow(row: any): Session {
    return {
      id: row.id,
      teacherId: row.teacher_id,
      islandId: row.island_id,
      currentActivity: row.current_activity,
      mode: row.mode,
      status: row.status,
      expiresAt: row.expires_at,
      settings: row.settings || { allowSelfPacing: false, autoAdvance: false },
      createdAt: row.created_at,
    };
  }
}
