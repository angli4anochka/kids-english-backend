const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const BUCKET = 'kids-app';
const ENDPOINT = 'https://storage.yandexcloud.net';
const LESSON_IDS = [
  'a0b2d763-4169-4441-9a38-7ac258a1be14', '25682633-dd7d-4a1b-be29-1735d974fcdd',
  '638624f9-099c-464d-9046-94c277a4940d', 'ead70c1a-d111-4dc3-af0d-ca3ed45b6560',
  '9be3d6fe-9698-40a8-9308-9bc582897f6c', '095edc36-625f-483a-bfc3-2a30ab95e37c',
  'b0ef622b-f63e-4f66-bdbb-6cc7c9c6771a', 'fa0cd530-5c49-4fdc-9a28-0b48cd60b6e0'
];
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'video/mp4': 'mp4' };
const pool = new Pool({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME || 'kids_english', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD });

function migrateValue(value, lessonId, stats, uploads) {
  if (typeof value === 'string' && value.startsWith('data:')) {
    const match = value.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) return value;
    const mime = match[1].toLowerCase();
    const body = Buffer.from(match[2], 'base64');
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const ext = MIME_EXT[mime] || 'bin';
    const key = 'public-assets/migrated/kidsbox/' + lessonId + '/' + sha + '.' + ext;
    const url = ENDPOINT + '/' + BUCKET + '/' + key;
    stats.files += 1; stats.bytes += body.length;
    uploads.set(key, { body, mime, url });
    return url;
  }
  if (Array.isArray(value)) return value.map((item) => migrateValue(item, lessonId, stats, uploads));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = migrateValue(item, lessonId, stats, uploads);
    return result;
  }
  return value;
}

function aws(args) {
  const result = spawnSync('aws', ['--endpoint-url', ENDPOINT].concat(args), { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'aws failed');
}

async function main() {
  const rows = (await pool.query('SELECT id, lesson_id, content_url, content_data FROM lesson_activities WHERE lesson_id = ANY($1::uuid[]) ORDER BY lesson_id, order_index', [LESSON_IDS])).rows;
  const backupDir = process.env.MIGRATION_BACKUP_DIR || path.join(os.homedir(), 'migration-backups');
  const backupPath = path.join(backupDir, 'kidsbox-content-data-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json.gz');
  const uploads = new Map();
  const changes = [];
  const stats = { files: 0, bytes: 0 };
  for (const row of rows) {
    const migrated = migrateValue(row.content_data, row.lesson_id, stats, uploads);
    const migratedUrl = migrateValue(row.content_url, row.lesson_id, stats, uploads);
    if (JSON.stringify(migrated) !== JSON.stringify(row.content_data) || migratedUrl !== row.content_url) {
      changes.push({ id: row.id, contentData: migrated, contentUrl: migratedUrl });
    }
  }
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', activities: rows.length, changedActivities: changes.length, references: stats.files, uniqueFiles: uploads.size, bytes: stats.bytes }));
  if (!APPLY || changes.length === 0) return;
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(backupPath, zlib.gzipSync(JSON.stringify(rows)));
  for (const [key, file] of uploads) {
    const temp = path.join(os.tmpdir(), path.basename(key));
    fs.writeFileSync(temp, file.body);
    aws(['s3', 'cp', temp, 's3://' + BUCKET + '/' + key, '--content-type', file.mime]);
    aws(['s3api', 'head-object', '--bucket', BUCKET, '--key', key]);
    fs.unlinkSync(temp);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const change of changes) await client.query('UPDATE lesson_activities SET content_data = $1::jsonb, content_url = $2 WHERE id = $3', [JSON.stringify(change.contentData), change.contentUrl, change.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
  console.log(JSON.stringify({ migrated: changes.length, uploaded: uploads.size, backupPath }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
