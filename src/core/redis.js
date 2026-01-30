import { createClient } from 'redis';
import config from '../config/index.js';
import { workerLogger } from './logger.js';

let redisClient = null;

export async function getRedisClient() {
  // Check if client exists and is open
  if (redisClient) {
    if (redisClient.isOpen) {
      return redisClient;
    } else {
      // Client exists but is closed, reset it
      redisClient = null;
    }
  }

  try {
    redisClient = createClient({
      url: config.REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            return new Error('Too many reconnection attempts');
          }
          return Math.min(retries * 100, 3000);
        },
      },
    });

    redisClient.on('error', (err) => {
      workerLogger.error(`Redis error: ${err.message}`);
      // Reset client on error so it can be recreated
      if (err.message && err.message.includes('closed')) {
        redisClient = null;
      }
    });

    redisClient.on('connect', () => {
      // Only log from worker, not from API routes
      if (process.env.WORKER_PROCESS === 'true') {
        workerLogger.info('Redis connected');
      }
    });

    redisClient.on('end', () => {
      workerLogger.warn('Redis connection ended');
      redisClient = null;
    });

    await redisClient.connect();
    return redisClient;
  } catch (error) {
    workerLogger.error(`Redis connection failed: ${error.message}`);
    redisClient = null;
    return null;
  }
}

export async function checkRedisConnection() {
  try {
    const client = await getRedisClient();
    if (client && client.isOpen) {
      await client.ping();
      return true;
    }
    // If client is closed, reset it and try again
    if (client && !client.isOpen) {
      redisClient = null;
      const newClient = await getRedisClient();
      if (newClient && newClient.isOpen) {
        await newClient.ping();
        return true;
      }
    }
  } catch (error) {
    // If client is closed, reset it
    if (error.message && error.message.includes('closed')) {
      redisClient = null;
    }
    workerLogger.error(`Redis ping failed: ${error.message}`);
  }
  return false;
}

export class JobManager {
  constructor() {
    this.JOBS_KEY = 'spider:jobs';
    this.JOB_PREFIX = 'spider:job:';
    this.QUEUE_KEY = 'spider:queue';
    this.redis = null;
  }

  async init() {
    this.redis = await getRedisClient();
    return this.redis !== null;
  }

  isConnected() {
    // Check if we have a redis reference and if it's still open
    if (!this.redis) {
      return false;
    }
    // If client was closed externally, reset our reference
    if (!this.redis.isOpen) {
      this.redis = null;
      return false;
    }
    return true;
  }

  async createJob(jobData) {
    if (!this.redis) {
      await this.init();
    }
    if (!this.isConnected()) {
      return null;
    }

    const {
      job_id,
      url,
      max_ads,
      save_json,
      save_db,
      auto_analyze = true,
      analysis_mode = 'balanced',
      page_id = null,
      start_date_formatted = null,
      end_date_formatted = null,
      period = null,
    } = jobData;

    const job = {
      job_id,
      url,
      max_ads,
      save_json,
      save_db,
      auto_analyze,
      analysis_mode,
      page_id,
      start_date_formatted,
      end_date_formatted,
      period,
      status: 'queued',
      progress: {
        scraped: 0,
        analyzed: 0,
        inserted: 0,
        pending: 0,
        failed: 0,
        total: max_ads,
      },
      result: null,
      error: null,
      message: null,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };

    await this.redis.hSet(this.JOB_PREFIX + job_id, {
      data: JSON.stringify(job),
    });
    await this.redis.lPush(this.JOBS_KEY, job_id);
    await this.redis.lPush(this.QUEUE_KEY, job_id);

    return job;
  }

  async getJob(job_id) {
    if (!this.isConnected()) {
      await this.init();
    }
    if (!this.isConnected()) {
      return null;
    }

    const data = await this.redis.hGet(this.JOB_PREFIX + job_id, 'data');
    if (!data) {
      return null;
    }

    return JSON.parse(data);
  }

  async getQueuedJob() {
    if (!this.isConnected()) {
      await this.init();
    }
    if (!this.isConnected()) {
      return null;
    }

    const job_id = await this.redis.rPop(this.QUEUE_KEY);
    return job_id;
  }

  async updateJob(job_id, updates) {
    if (!this.isConnected()) {
      await this.init();
    }
    if (!this.isConnected()) {
      return false;
    }

    const job = await this.getJob(job_id);
    if (!job) {
      return false;
    }

    Object.assign(job, updates);
    await this.redis.hSet(this.JOB_PREFIX + job_id, {
      data: JSON.stringify(job),
    });

    return true;
  }

  async updateProgress(job_id, progressUpdates) {
    if (!this.isConnected()) {
      await this.init();
    }
    if (!this.isConnected()) {
      return false;
    }

    const job = await this.getJob(job_id);
    if (!job) {
      return false;
    }

    Object.assign(job.progress, progressUpdates);
    
    // Update message if provided
    if (progressUpdates.message) {
      job.message = progressUpdates.message;
    }

    await this.redis.hSet(this.JOB_PREFIX + job_id, {
      data: JSON.stringify(job),
    });

    return true;
  }

  async setRunning(job_id) {
    return this.updateJob(job_id, {
      status: 'running',
      started_at: new Date().toISOString(),
    });
  }

  async setCompleted(job_id, result) {
    return this.updateJob(job_id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      result,
    });
  }

  async setFailed(job_id, error) {
    return this.updateJob(job_id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error,
    });
  }

  async getAllJobs(limit = 50) {
    if (!this.isConnected()) {
      await this.init();
    }
    if (!this.isConnected()) {
      return [];
    }

    const jobIds = await this.redis.lRange(this.JOBS_KEY, 0, limit - 1);
    const jobs = [];

    for (const jobId of jobIds) {
      const job = await this.getJob(jobId);
      if (job) {
        jobs.push(job);
      }
    }

    return jobs.reverse(); // Most recent first
  }

  async clearCompleted() {
    if (!this.isConnected()) {
      await this.init();
    }
    if (!this.isConnected()) {
      return 0;
    }

    const jobs = await this.getAllJobs();
    let count = 0;

    for (const job of jobs) {
      if (job.status === 'completed') {
        await this.redis.hDel(this.JOB_PREFIX + job.job_id, 'data');
        await this.redis.lRem(this.JOBS_KEY, 0, job.job_id);
        count++;
      }
    }

    return count;
  }

  async clearFailed() {
    if (!this.isConnected()) {
      await this.init();
    }
    if (!this.isConnected()) {
      return 0;
    }

    const jobs = await this.getAllJobs();
    let count = 0;

    for (const job of jobs) {
      if (job.status === 'failed') {
        await this.redis.hDel(this.JOB_PREFIX + job.job_id, 'data');
        await this.redis.lRem(this.JOBS_KEY, 0, job.job_id);
        count++;
      }
    }

    return count;
  }

  async clearCancelled() {
    if (!this.isConnected()) {
      await this.init();
    }
    if (!this.isConnected()) {
      return 0;
    }

    const jobs = await this.getAllJobs();
    let count = 0;

    for (const job of jobs) {
      if (job.status === 'cancelled') {
        await this.redis.hDel(this.JOB_PREFIX + job.job_id, 'data');
        await this.redis.lRem(this.JOBS_KEY, 0, job.job_id);
        count++;
      }
    }

    return count;
  }

  async getStats() {
    if (!this.isConnected()) {
      await this.init();
    }
    if (!this.isConnected()) {
      return {
        total: 0,
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        total_scraped: 0,
        total_analyzed: 0,
        total_inserted: 0,
        total_pending: 0,
        total_failed: 0,
      };
    }

    const jobs = await this.getAllJobs();

    const stats = {
      total: jobs.length,
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total_scraped: 0,
      total_analyzed: 0,
      total_inserted: 0,
      total_pending: 0,
      total_failed: 0,
    };

    for (const job of jobs) {
      const status = job.status || 'unknown';
      if (stats.hasOwnProperty(status)) {
        stats[status]++;
      }

      const progress = job.progress || {};
      stats.total_scraped += progress.scraped || 0;
      stats.total_analyzed += progress.analyzed || 0;
      stats.total_inserted += progress.inserted || 0;
      stats.total_pending += progress.pending || 0;
      stats.total_failed += progress.failed || 0;
    }

    return stats;
  }

  async deleteJob(job_id) {
    if (!this.isConnected()) {
      await this.init();
    }
    if (!this.isConnected()) {
      return false;
    }

    await this.redis.del(this.JOB_PREFIX + job_id);
    await this.redis.lRem(this.JOBS_KEY, 0, job_id);
    await this.redis.lRem(this.QUEUE_KEY, 0, job_id);
    return true;
  }

  async cancelJob(job_id) {
    if (!this.isConnected()) {
      await this.init();
    }
    if (!this.isConnected()) {
      return false;
    }

    await this.updateJob(job_id, { status: 'cancelled' });
    await this.redis.lRem(this.QUEUE_KEY, 0, job_id);
    return true;
  }

  async requeueJob(job_id) {
    if (!this.isConnected()) {
      await this.init();
    }
    if (!this.isConnected()) {
      return false;
    }

    const job = await this.getJob(job_id);
    if (!job) {
      return false;
    }

    job.status = 'queued';
    job.error = null;
    job.progress = {
      scraped: 0,
      analyzed: 0,
      inserted: 0,
      pending: 0,
      failed: 0,
      total: job.max_ads,
    };

    await this.redis.hSet(this.JOB_PREFIX + job_id, {
      data: JSON.stringify(job),
    });
    await this.redis.lPush(this.QUEUE_KEY, job_id);
    return true;
  }

  async close() {
    // Don't close the shared Redis client - it's shared across all JobManager instances
    // Just clear the reference for this instance
    this.redis = null;
  }
}

export default { getRedisClient, checkRedisConnection, JobManager };
