import { pgPool } from '../config/database';
import { StudentProgress } from '../types';
import { v4 as uuidv4 } from 'uuid';

export class ProgressModel {
  static async create(
    studentId: string,
    sessionId: string,
    activityId: string,
    score: number,
    data: any
  ): Promise<StudentProgress> {
    const id = uuidv4();
    const query = `
      INSERT INTO student_progress (id, student_id, session_id, activity_id, score, data)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const result = await pgPool.query(query, [id, studentId, sessionId, activityId, score, data]);
    return this.mapRow(result.rows[0]);
  }

  static async update(
    id: string,
    score: number,
    data: any,
    completed: boolean = false
  ): Promise<StudentProgress> {
    const completedAt = completed ? new Date() : null;
    const query = `
      UPDATE student_progress
      SET score = $1, data = $2, completed_at = $3
      WHERE id = $4
      RETURNING *
    `;
    const result = await pgPool.query(query, [score, data, completedAt, id]);
    return this.mapRow(result.rows[0]);
  }

  static async findByStudentAndSession(
    studentId: string,
    sessionId: string
  ): Promise<StudentProgress[]> {
    const query = `
      SELECT * FROM student_progress
      WHERE student_id = $1 AND session_id = $2
      ORDER BY created_at DESC
    `;
    const result = await pgPool.query(query, [studentId, sessionId]);
    return result.rows.map(this.mapRow);
  }

  static async findByStudentActivitySession(
    studentId: string,
    sessionId: string,
    activityId: string
  ): Promise<StudentProgress | null> {
    const query = `
      SELECT * FROM student_progress
      WHERE student_id = $1 AND session_id = $2 AND activity_id = $3
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const result = await pgPool.query(query, [studentId, sessionId, activityId]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  static async getTotalScoreForSession(studentId: string, sessionId: string): Promise<number> {
    const query = `
      SELECT COALESCE(SUM(score), 0) as total
      FROM student_progress
      WHERE student_id = $1 AND session_id = $2
    `;
    const result = await pgPool.query(query, [studentId, sessionId]);
    return parseInt(result.rows[0].total);
  }

  private static mapRow(row: any): StudentProgress {
    return {
      id: row.id,
      studentId: row.student_id,
      sessionId: row.session_id,
      activityId: row.activity_id,
      score: row.score,
      data: row.data,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    };
  }
}
