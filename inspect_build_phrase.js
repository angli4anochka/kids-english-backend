require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("select id, lesson_id, type, title, content_url, content_data from activities where lower(title) like '%build%phrase%' or lower(title) like '%build%name%' order by created_at desc limit 20")
  .then(({ rows }) => console.log(JSON.stringify(rows, null, 2)))
  .catch((error) => console.error(error.message))
  .finally(() => pool.end());
