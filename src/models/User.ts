import { pgPool } from '../config/database';
import { User, UserRole } from '../types';
import { v4 as uuidv4 } from 'uuid';

export class UserModel {
  static async create(displayName: string, role: UserRole, avatarColor: string): Promise<User> {
    const id = uuidv4();
    const query = `
      INSERT INTO users (id, display_name, role, avatar_color)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    const result = await pgPool.query(query, [id, displayName, role, avatarColor]);
    return this.mapRow(result.rows[0]);
  }

  static async findById(id: string): Promise<User | null> {
    const query = 'SELECT * FROM users WHERE id = $1';
    const result = await pgPool.query(query, [id]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  static async findBySessionCode(sessionCode: string): Promise<User | null> {
    const query = 'SELECT * FROM users WHERE session_code = $1';
    const result = await pgPool.query(query, [sessionCode]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  static async updateSessionCode(userId: string, sessionCode: string | null): Promise<void> {
    const query = 'UPDATE users SET session_code = $1 WHERE id = $2';
    await pgPool.query(query, [sessionCode, userId]);
  }

  static async updateCurrentSession(userId: string, sessionId: string | null): Promise<void> {
    const query = 'UPDATE users SET current_session_id = $1 WHERE id = $2';
    await pgPool.query(query, [sessionId, userId]);
  }

  private static mapRow(row: any): User {
    return {
      id: row.id,
      sessionCode: row.session_code,
      role: row.role,
      displayName: row.display_name,
      avatarColor: row.avatar_color,
      currentSessionId: row.current_session_id,
      createdAt: row.created_at,
    };
  }
}
