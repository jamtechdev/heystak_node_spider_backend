import express from 'express';
import { readdir, stat, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import config from '../config/index.js';
import { JobManager, checkRedisConnection } from '../core/redis.js';
import { apiLogger } from '../core/logger.js';

const router = express.Router();

async function getDataFiles() {
  const files = [];
  
  if (!existsSync(config.DATA_DIR)) {
    return files;
  }

  try {
    const fileList = await readdir(config.DATA_DIR);
    
    for (const filename of fileList) {
      if (filename.startsWith('debug_') || !filename.endsWith('.json')) {
        continue;
      }

      const filepath = join(config.DATA_DIR, filename);
      const fileStat = await stat(filepath);

      let count = 0;
      let analyzed = 0;

      try {
        const content = await readFile(filepath, 'utf-8');
        const ads = JSON.parse(content);
        count = Array.isArray(ads) ? ads.length : 0;
        analyzed = Array.isArray(ads) ? ads.filter((a) => a.analysis).length : 0;
      } catch (error) {
        apiLogger.warn(`[Dashboard] Error reading file ${filename}: ${error.message}`);
      }

      files.push({
        filename,
        filepath,
        size_kb: Math.round((fileStat.size / 1024) * 100) / 100,
        created: fileStat.birthtime.toISOString(),
        count,
        analyzed,
      });
    }

    // Sort by created date, most recent first
    files.sort((a, b) => new Date(b.created) - new Date(a.created));
  } catch (error) {
    apiLogger.error(`[Dashboard] Error reading data directory: ${error.message}`);
  }

  return files;
}

router.get('/stats', async (req, res) => {
  try {
    const files = await getDataFiles();

    const totalAds = files.reduce((sum, f) => sum + f.count, 0);
    const totalAnalyzed = files.reduce((sum, f) => sum + f.analyzed, 0);
    const totalSize = files.reduce((sum, f) => sum + f.size_kb, 0);

    const stats = {
      files: {
        total: files.length,
        total_ads: totalAds,
        total_analyzed: totalAnalyzed,
        total_size_kb: Math.round(totalSize * 100) / 100,
      },
      redis: {},
    };

    // Add Redis stats if available
    const redisAvailable = await checkRedisConnection();
    if (redisAvailable) {
      const jobManager = new JobManager();
      await jobManager.init();
      const redisStats = await jobManager.getStats();
      await jobManager.close();

      stats.redis = {
        total: redisStats.total || 0,
        running: redisStats.running || 0,
        queued: redisStats.queued || 0,
        completed: redisStats.completed || 0,
        failed: redisStats.failed || 0,
        total_scraped: redisStats.total_scraped || 0,
        total_analyzed: redisStats.total_analyzed || 0,
        total_inserted: redisStats.total_inserted || 0,
        total_pending: redisStats.total_pending || 0,
        total_failed: redisStats.total_failed || 0,
      };

      // Add top-level aggregated stats for easy access (primary from Redis jobs)
      stats.scraped = redisStats.total_scraped || 0;
      stats.analyzed = redisStats.total_analyzed || 0;
      stats.inserted = redisStats.total_inserted || 0;
      stats.pending = redisStats.total_pending || 0;
      stats.failed = redisStats.total_failed || 0;
    } else {
      // If no Redis, use file-based stats only
      stats.scraped = totalAds;
      stats.analyzed = totalAnalyzed;
      stats.inserted = 0;
      stats.pending = 0;
      stats.failed = 0;
    }

    res.json(stats);
  } catch (error) {
    apiLogger.error(`[Dashboard] Error getting stats: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/files', async (req, res) => {
  try {
    const files = await getDataFiles();
    res.json({
      total: files.length,
      files: files.slice(0, 50), // Limit to 50 most recent
    });
  } catch (error) {
    apiLogger.error(`[Dashboard] Error getting files: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/services', async (req, res) => {
  try {
    const redisAvailable = await checkRedisConnection();

    res.json({
      apify: {
        available: !!config.APIFY_API_TOKEN,
        configured: !!config.APIFY_API_TOKEN,
      },
      redis: {
        available: redisAvailable,
        connected: redisAvailable,
      },
      supabase: {
        available: !!(config.SUPABASE_URL && config.SUPABASE_KEY),
        configured: !!(config.SUPABASE_URL && config.SUPABASE_KEY),
      },
      openai: {
        available: !!config.OPENAI_API_KEY,
        configured: !!config.OPENAI_API_KEY,
      },
    });
  } catch (error) {
    apiLogger.error(`[Dashboard] Error getting services status: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/file/:filename/stats', async (req, res) => {
  try {
    const { filename } = req.params;
    const filepath = join(config.DATA_DIR, filename);

    if (!existsSync(filepath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const fileStat = await stat(filepath);
    const content = await readFile(filepath, 'utf-8');
    const ads = JSON.parse(content);

    const stats = {
      total: ads.length,
      active: ads.filter((a) => a.is_active).length,
      images: ads.filter((a) => a.snapshot?.images).length,
      videos: ads.filter((a) => a.snapshot?.videos).length,
      carousels: ads.filter((a) => a.snapshot?.cards).length,
      analyzed: ads.filter((a) => a.analysis).length,
    };

    res.json({
      filename,
      stats,
      file_info: {
        size_kb: Math.round((fileStat.size / 1024) * 100) / 100,
        created: fileStat.birthtime.toISOString(),
        modified: fileStat.mtime.toISOString(),
      },
    });
  } catch (error) {
    apiLogger.error(`[Dashboard] Error getting file stats: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
