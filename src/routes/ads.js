import express from 'express';
import { readdir, stat, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import config from '../config/index.js';
import { apiLogger } from '../core/logger.js';

const router = express.Router();

router.get('/files', async (req, res) => {
  try {
    const files = [];
    
    if (!existsSync(config.DATA_DIR)) {
      return res.json({
        data_dir: config.DATA_DIR,
        total_files: 0,
        files: [],
      });
    }

    const fileList = await readdir(config.DATA_DIR);
    
    for (const filename of fileList) {
      if (!filename.endsWith('.json')) {
        continue;
      }

      const filepath = join(config.DATA_DIR, filename);
      const fileStat = await stat(filepath);

      files.push({
        filename,
        size_kb: Math.round((fileStat.size / 1024) * 100) / 100,
        created: fileStat.birthtime.getTime() / 1000, // Unix timestamp
      });
    }

    // Sort by created date, most recent first
    files.sort((a, b) => b.created - a.created);

    res.json({
      data_dir: config.DATA_DIR,
      total_files: files.length,
      files,
    });
  } catch (error) {
    apiLogger.error(`[API] Error listing files: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/files/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const filepath = join(config.DATA_DIR, filename);

    if (!existsSync(filepath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (!filename.endsWith('.json')) {
      return res.status(400).json({ error: 'Only JSON files supported' });
    }

    const content = await readFile(filepath, 'utf-8');
    const data = JSON.parse(content);

    res.json({
      filename,
      total_ads: Array.isArray(data) ? data.length : 1,
      data,
    });
  } catch (error) {
    apiLogger.error(`[API] Error reading file: ${error.message}`);
    res.status(500).json({ error: `Error reading file: ${error.message}` });
  }
});

router.get('/page/:pageId', async (req, res) => {
  try {
    const { pageId } = req.params;
    const allAds = [];

    if (!existsSync(config.DATA_DIR)) {
      return res.status(404).json({ error: `No ads found for page ${pageId}` });
    }

    const fileList = await readdir(config.DATA_DIR);
    const matchingFiles = fileList.filter((f) => f.startsWith(`${pageId}_`) && f.endsWith('.json'));

    for (const filename of matchingFiles) {
      try {
        const filepath = join(config.DATA_DIR, filename);
        const content = await readFile(filepath, 'utf-8');
        const data = JSON.parse(content);
        if (Array.isArray(data)) {
          allAds.push(...data);
        }
      } catch (error) {
        apiLogger.warn(`[API] Error reading file ${filename}: ${error.message}`);
      }
    }

    if (allAds.length === 0) {
      return res.status(404).json({ error: `No ads found for page ${pageId}` });
    }

    // Dedupe by ad_archive_id
    const unique = {};
    for (const ad of allAds) {
      const aid = ad.ad_archive_id;
      if (aid && !unique[aid]) {
        unique[aid] = ad;
      }
    }

    res.json({
      page_id: pageId,
      total_ads: Object.keys(unique).length,
      ads: Object.values(unique),
    });
  } catch (error) {
    apiLogger.error(`[API] Error getting ads by page: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/files/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const filepath = join(config.DATA_DIR, filename);

    if (!existsSync(filepath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    await unlink(filepath);
    res.json({ message: `Deleted ${filename}` });
  } catch (error) {
    apiLogger.error(`[API] Error deleting file: ${error.message}`);
    res.status(500).json({ error: `Error deleting file: ${error.message}` });
  }
});

export default router;
