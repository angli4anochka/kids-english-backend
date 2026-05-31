import { Pool } from 'pg';
import { createClient, RedisClientType } from 'redis';
import logger from '../utils/logger';

// PostgreSQL connection pool
export const pgPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'english_app',
  user: process.env.DB_USER || 'app_user',
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pgPool.on('connect', () => {
  logger.info('PostgreSQL connected');
});

pgPool.on('error', (err) => {
  logger.error('PostgreSQL pool error:', err);
});

// Redis clients
export let redisClient: RedisClientType;
export let redisPubClient: RedisClientType;
export let redisSubClient: RedisClientType;

export async function initializeRedis() {
  const redisConfig = {
    socket: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
    },
    password: process.env.REDIS_PASSWORD || undefined,
  };

  // Main client for caching
  redisClient = createClient(redisConfig);
  redisClient.on('error', (err) => logger.error('Redis Client Error:', err));
  redisClient.on('connect', () => logger.info('Redis connected'));
  await redisClient.connect();

  // Pub/Sub clients for Socket.io adapter
  redisPubClient = createClient(redisConfig);
  await redisPubClient.connect();

  redisSubClient = redisPubClient.duplicate();
  await redisSubClient.connect();

  logger.info('Redis clients initialized');
}

// Graceful shutdown
export async function closeConnections() {
  logger.info('Closing database connections...');
  await pgPool.end();
  await redisClient.quit();
  await redisPubClient.quit();
  await redisSubClient.quit();
  logger.info('Connections closed');
}
