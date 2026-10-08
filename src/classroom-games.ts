import { registerInteractivePages } from './interactive-pages';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { randomUUID, randomInt } from 'crypto';

export function registerClassroomGames(app: Express, pool: Pool) {
  let ready: Promise<any> | null = null;
  const ensure = () => ready ||= pool.query(`CREATE TABLE IF NOT EXISTS classroom_game_states (
    session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
    activity_id UUID NOT NULL REFERENCES lesson_activities(id) ON DELETE CASCADE,
    state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(session_id,activity_id))`).catch(error => { ready = null; throw error; });
  registerInteractivePages(app, pool, ensure);
  const valid = (value: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
  const path = '/live-sessions/:sessionId/games/:activityId';
  app.get(path, async (req, res) => {
    if (!valid(String(req.params.sessionId)) || !valid(String(req.params.activityId))) return res.status(400).json({success:false});
    try {
      await ensure();
      const result = await pool.query('SELECT state FROM classroom_game_states WHERE session_id=$1 AND activity_id=$2', [req.params.sessionId,req.params.activityId]);
      return res.json({success:true,data:result.rows[0]?.state ? {...result.rows[0].state,remaining:undefined} : null});
    } catch { return res.status(500).json({success:false,error:'Could not load Bingo state'}); }
  });
  app.put(path, async (req, res) => {
    const {sessionId,activityId} = req.params;
    if (!valid(String(sessionId)) || !valid(String(activityId)) || !['next','reset'].includes(req.body.action)) return res.status(400).json({success:false});
    // Uses the same teacher token format as this application's auth routes.
    const token = req.headers.authorization?.replace(/^Bearer /,'') || '';
    const identity = Buffer.from(token,'base64').toString('utf8').split(':')[0];
    let client;
    try {
    const session = await pool.query(`SELECT ls.teacher_id FROM live_sessions ls JOIN lesson_activities la ON la.lesson_id=ls.lesson_id WHERE ls.id=$1 AND la.id=$2 AND ls.status='active'`,[sessionId,activityId]);
    if (!identity || identity !== String(session.rows[0]?.teacher_id)) return res.status(403).json({success:false,error:'Only this session teacher can call numbers'});
      await ensure(); client = await pool.connect(); await client.query('BEGIN');
      // Serialize calls for this session, including the first request before a state row exists.
      await client.query('SELECT id FROM live_sessions WHERE id=$1 FOR UPDATE',[sessionId]);
      const result = await client.query('SELECT state FROM classroom_game_states WHERE session_id=$1 AND activity_id=$2',[sessionId,activityId]);
      let state = result.rows[0]?.state;
      if (!state || req.body.action==='reset') {
        const remaining=Array.from({length:10},(_,i)=>i+1);
        for(let i=9;i>0;i--){const j=randomInt(i+1);[remaining[i],remaining[j]]=[remaining[j],remaining[i]];}
        state={roundId:randomUUID(),called:[],current:null,remaining,version:0};
      }
      if(req.body.action==='next' && state.remaining.length){state.current=state.remaining.shift();state.called.push(state.current);}
      state.version++;
      await client.query(`INSERT INTO classroom_game_states(session_id,activity_id,state) VALUES($1,$2,$3) ON CONFLICT(session_id,activity_id) DO UPDATE SET state=EXCLUDED.state,updated_at=NOW()`,[sessionId,activityId,JSON.stringify(state)]);
      await client.query('COMMIT'); return res.json({success:true,data:{...state,remaining:undefined}});
    } catch { if(client)await client.query('ROLLBACK');return res.status(500).json({success:false,error:'Could not update Bingo state'}); }
    finally { client?.release(); }
  });
}
