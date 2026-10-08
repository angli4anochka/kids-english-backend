import type { Express } from 'express';
import type { Pool } from 'pg';

export function registerInteractivePages(app: Express, pool: Pool, ensure: () => Promise<any>) {
  const valid = (v: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
  const path = '/live-sessions/:sessionId/interactive-pages/:activityId';
  const context = async (sessionId: string, activityId: string) => {
    const result = await pool.query(`SELECT ls.teacher_id, la.content_data FROM live_sessions ls
      JOIN lesson_activities la ON la.lesson_id=ls.lesson_id
      WHERE ls.id=$1 AND la.id=$2 AND ls.status='active'`, [sessionId, activityId]);
    const row = result.rows[0];
    return row && Number.isInteger(row.content_data?.pageSync?.pageCount) ? row : null;
  };
  app.get(path, async (req, res) => {
    const sessionId = String(req.params.sessionId), activityId = String(req.params.activityId);
    if (!valid(sessionId) || !valid(activityId)) return res.status(400).json({success:false});
    try {
      if (!await context(sessionId, activityId)) return res.status(404).json({success:false});
      await ensure();
      const result = await pool.query('SELECT state FROM classroom_game_states WHERE session_id=$1 AND activity_id=$2', [sessionId, activityId]);
      const state = result.rows[0]?.state;
      return res.json({success:true,data:state?.source==='interactive-pages' ? state : {source:'interactive-pages',page:0,version:0}});
    } catch { return res.status(500).json({success:false}); }
  });
  app.put(path, async (req, res) => {
    const sessionId = String(req.params.sessionId), activityId = String(req.params.activityId);
    const page = req.body?.page;
    if (!valid(sessionId) || !valid(activityId) || !Number.isInteger(page) || page<0) return res.status(400).json({success:false});
    try {
      const row = await context(sessionId, activityId);
      if (!row) return res.status(404).json({success:false});
      const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
      const identity = Buffer.from(token,'base64').toString('utf8').split(':')[0];
      if (!identity || identity!==String(row.teacher_id)) return res.status(403).json({success:false});
      if (page>=row.content_data.pageSync.pageCount) return res.status(400).json({success:false});
      await ensure();
      const result = await pool.query(`INSERT INTO classroom_game_states(session_id,activity_id,state)
        VALUES($1,$2,jsonb_build_object('source','interactive-pages','page',$3::int,'version',1))
        ON CONFLICT(session_id,activity_id) DO UPDATE SET state=jsonb_build_object(
          'source','interactive-pages','page',$3::int,'version',COALESCE((classroom_game_states.state->>'version')::int,0)+1),updated_at=NOW()
        RETURNING state`, [sessionId,activityId,page]);
      return res.json({success:true,data:result.rows[0].state});
    } catch { return res.status(500).json({success:false}); }
  });
}
