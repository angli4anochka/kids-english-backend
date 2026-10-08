require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
const sql = `
select 'sessions' as kind, json_agg(x) as data from (
  select id, lesson_id, group_id, status, created_at from live_sessions order by created_at desc limit 10
) x
union all
select 'students' as kind, json_agg(x) as data from (
  select u.id, u.name, u.email, u.group_id, g.name as group_name
  from users u left join groups g on g.id=u.group_id
  where u.role='student' order by u.group_id, u.name
) x`;
pool.query(sql).then(({rows}) => console.log(JSON.stringify(rows,null,2))).catch(e => console.error(e.message)).finally(() => pool.end());
