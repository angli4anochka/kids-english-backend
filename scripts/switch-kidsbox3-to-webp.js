const { Pool } = require('pg');
require('dotenv').config();
const lessonId = '638624f9-099c-464d-9046-94c277a4940d';
const hashes = ['01e8efe1988fba86f11ce183a39d8cf7a87f22c4c536b935b0d10c05263c560e','2dbe6a1a8dc88c3c04dfde8728185754e06a47176b416918cd678a916ced05e0','e32bc17110b3453f2e8c3faba5004fd91f9b7a5c3623de3c9217d39600f436b9','f4b5faecf25cce7f7f0cab066fe7c796036ee2b844b347f01de444182122ada4'];
const base = 'https://storage.yandexcloud.net/kids-app/public-assets/migrated/kidsbox/' + lessonId + '/';
const pool = new Pool({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME || 'kids_english', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD });
async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const hash of hashes) {
      const oldUrl = base + hash + '.png';
      const newUrl = base + hash + '.webp';
      await client.query("UPDATE lesson_activities SET content_data = replace(content_data::text, $1, $2)::jsonb, content_url = CASE WHEN content_url = $1 THEN $2 ELSE content_url END WHERE lesson_id = $3", [oldUrl, newUrl, lessonId]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  console.log('SWITCHED_TO_WEBP');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
