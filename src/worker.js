import config from './config/index.js';
import { checkRedisConnection, JobManager } from './core/redis.js';
import { workerLogger } from './core/logger.js';
import ApifyFacebookScraper from './scraper/apifyScraper.js';
import AdAnalyzer from './analyzer/adAnalyzer.js';
import SupabaseStorage from './db/supabaseStorage.js';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import axios from 'axios';

// Mark this as a worker process
process.env.WORKER_PROCESS = 'true';

const MAX_WORKERS = config.MAX_WORKERS;

class SpiderWorker {
  constructor() {
    this.running = true;
    this.activeJobs = new Map();
  }

  async run() {
    workerLogger.info('='.repeat(60));
    workerLogger.info(`[SPIDER] Spider Worker Started (Parallel: ${MAX_WORKERS} workers)`);
    workerLogger.info('='.repeat(60));

    // Check Redis
    const redisAvailable = await checkRedisConnection();
    if (!redisAvailable) {
      workerLogger.error('[Worker] Redis not connected!');
      return;
    }

    workerLogger.info('[Worker] Connected to Redis');
    workerLogger.info(`[Worker] Processing up to ${MAX_WORKERS} jobs simultaneously\n`);

    // Main loop
    while (this.running) {
      try {
        // Clean up completed jobs
        this._cleanupCompletedJobs();

        // Submit new jobs if we have capacity
        const availableSlots = MAX_WORKERS - this.activeJobs.size;
        if (availableSlots > 0) {
          try {
            const jobManager = new JobManager();
            const initialized = await jobManager.init();
            
            if (!initialized) {
              workerLogger.warn('[Worker] Failed to initialize Redis connection, retrying...');
              await new Promise((resolve) => setTimeout(resolve, 2000));
              continue;
            }

            for (let i = 0; i < availableSlots; i++) {
              try {
                const jobId = await jobManager.getQueuedJob();
                if (jobId) {
                  workerLogger.info(`[Worker] Found queued job: ${jobId}`);
                  const job = await jobManager.getJob(jobId);
                  if (job) {
                    await jobManager.setRunning(jobId);
                    await jobManager.close();

                    // Process job in background
                    this._processJob(jobId, job).catch((error) => {
                      workerLogger.error(`[Worker] Job ${jobId} error: ${error.message}`);
                    });
                  } else {
                    workerLogger.warn(`[Worker] Job ${jobId} not found in Redis`);
                  }
                } else {
                  // No more jobs in queue
                  break;
                }
              } catch (error) {
                workerLogger.error(`[Worker] Error getting queued job: ${error.message}`);
                workerLogger.error(`[Worker] Error stack: ${error.stack}`);
                break;
              }
            }

            await jobManager.close();
          } catch (error) {
            workerLogger.error(`[Worker] Error in job submission loop: ${error.message}`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }

        // Log status periodically
        if (this.activeJobs.size === 0 && Math.random() < 0.1) {
          // Log every ~10th iteration when idle (roughly every 20 seconds)
          workerLogger.debug(`[Worker] Idle - waiting for jobs. Active: ${this.activeJobs.size}/${MAX_WORKERS}`);
        }

        // Wait before next check
        await new Promise((resolve) => setTimeout(resolve, this.activeJobs.size > 0 ? 500 : 2000));
      } catch (error) {
        workerLogger.error(`[Worker] Error in main loop: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  _cleanupCompletedJobs() {
    for (const [jobId, jobInfo] of this.activeJobs.entries()) {
      // Check if job promise is resolved (completed)
      if (jobInfo && jobInfo.isResolved) {
        this.activeJobs.delete(jobId);
      }
    }
  }

  async _processJob(jobId, job) {
    this.activeJobs.set(jobId, { isResolved: false });

    try {
      workerLogger.info('='.repeat(60));
      workerLogger.info(`[Worker] Processing job: ${jobId}`);
      workerLogger.info(`[Worker] URL: ${job.url.substring(0, 60)}...`);
      workerLogger.info(`[Worker] Max ads: ${job.max_ads}`);
      workerLogger.info('='.repeat(60));

      const jobManager = new JobManager();
      await jobManager.init();

      // Step 1: Scrape with Apify
      workerLogger.info(`[Worker] Step 1: Scraping with Apify...`);
      const scraper = new ApifyFacebookScraper(config.APIFY_API_TOKEN);

      // Enforce max ads limit (safety check for old jobs)
      const maxAds = Math.min(job.max_ads || config.MAX_ADS_PER_BRAND, config.MAX_ADS_PER_BRAND);
      if (job.max_ads > config.MAX_ADS_PER_BRAND) {
        workerLogger.warn(`[Worker] Job max_ads (${job.max_ads}) exceeds limit (${config.MAX_ADS_PER_BRAND}), capping to ${maxAds}`);
      }

      const progressCallback = async (current, total, message) => {
        await jobManager.updateProgress(jobId, {
          scraped: current,
          total,
          message,
        });
      };

      let ads;
      try {
        ads = await scraper.scrape(
          job.url,
          maxAds,
          progressCallback,
          job.period,
          job.start_date_formatted,
          job.end_date_formatted
        );
      } catch (scrapeError) {
        const errorMsg = scrapeError.message || String(scrapeError);
        let userMsg = `Scraping failed: ${errorMsg}`;

        if (errorMsg.toLowerCase().includes('usage limit')) {
          userMsg = 'Apify monthly usage limit exceeded. Please upgrade your Apify plan or wait for the limit to reset.';
        } else if (errorMsg.toLowerCase().includes('rate limit')) {
          userMsg = 'Apify rate limit exceeded. Please try again later.';
        }

        workerLogger.error(`[Worker] Scraping error: ${errorMsg}`);
        await jobManager.setFailed(jobId, userMsg);
        await jobManager.close();
        this.activeJobs.delete(jobId);
        return;
      }

      if (!ads || ads.length === 0) {
        workerLogger.warn(`[Worker] No ads found`);
        await jobManager.setFailed(jobId, 'No ads found');
        await jobManager.close();
        this.activeJobs.delete(jobId);
        return;
      }

      workerLogger.info(`[Worker] Scraped ${ads.length} ads`);
      await jobManager.updateProgress(jobId, { scraped: ads.length, pending: ads.length });

      // Step 2: Auto-Analyze with AI
      if (job.auto_analyze && config.OPENAI_API_KEY) {
        workerLogger.info(`[Worker] Step 2: Analyzing with AI (${job.analysis_mode})...`);
        const analyzer = new AdAnalyzer(config.OPENAI_API_KEY);

        for (let i = 0; i < ads.length; i++) {
          try {
            await analyzer.analyzeAd(ads[i], job.analysis_mode);
            if ((i + 1) % 5 === 0) {
              await jobManager.updateProgress(jobId, { analyzed: i + 1 });
            }
          } catch (error) {
            workerLogger.error(`[Worker] Analysis error for ad ${i}: ${error.message}`);
          }
        }

        analyzer.close();
        workerLogger.info(`[Worker] Analyzed ${ads.length} ads`);
      } else {
        workerLogger.warn(`[Worker] Skipping analysis (disabled or no key)`);
      }

      // Step 3: Save JSON
      if (job.save_json) {
        workerLogger.info(`[Worker] Step 3: Saving JSON...`);
        await this._saveJson(jobId, ads, job.url);
      }

      // Step 4: Save to Database
      let dbSaveResult = null;
      if (job.save_db && config.SUPABASE_URL && config.SUPABASE_KEY) {
        workerLogger.info(`[Worker] Step 4: Saving to database...`);
        dbSaveResult = await this._saveToDatabase(jobId, ads, jobManager);
        await jobManager.updateProgress(jobId, {
          inserted: dbSaveResult.success,
          failed: dbSaveResult.failed,
          pending: 0,
        });
      } else {
        await jobManager.updateProgress(jobId, { pending: 0 });
      }

      // Complete
      await jobManager.setCompleted(jobId, {
        ads_scraped: ads.length,
        ads_analyzed: ads.filter((a) => a.analysis).length,
        ads_inserted: (await jobManager.getJob(jobId)).progress.inserted,
      });

      // Auto-complete user_request if page_id is available AND ads were successfully saved
      const pageId = job.page_id;
      const adsInserted = dbSaveResult ? dbSaveResult.success : 0;
      if (pageId && config.SUPABASE_URL && config.SUPABASE_KEY && adsInserted > 0) {
        workerLogger.info(`[Worker] Updating user_request and user_brand for page_id: ${pageId}`);
        await this.markUserRequestComplete(pageId);
        // Create user_brand relationship and notification (returns userId for later use)
        const userId = await this.createUserBrandAndNotification(pageId);
        // Update user_brand.last_scrap only if period is set (Get New Ads)
        const period = job.period;
        if (period && userId) {
          await this.updateUserBrandLastScrap(pageId, userId);
        }
      } else if (pageId && !job.save_db) {
        workerLogger.info(`[Worker] Skipping user_request/user_brand update (save_db is false)`);
      } else if (pageId && adsInserted === 0) {
        workerLogger.warn(`[Worker] Skipping user_request/user_brand update (no ads were inserted)`);
      }

      await jobManager.close();
      workerLogger.info(`[Worker] Job ${jobId} completed!`);
    } catch (error) {
      workerLogger.error(`[Worker] Job ${jobId} failed: ${error.message}`);
      const jobManager = new JobManager();
      await jobManager.init();
      await jobManager.setFailed(jobId, error.message);
      await jobManager.close();
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  async _saveJson(jobId, ads, url) {
    const pageIdMatch = url.match(/view_all_page_id=(\d+)/);
    const pageId = pageIdMatch ? pageIdMatch[1] : 'unknown';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `${pageId}_${timestamp}.json`;
    const filepath = join(config.DATA_DIR, filename);

    if (!existsSync(config.DATA_DIR)) {
      mkdirSync(config.DATA_DIR, { recursive: true });
    }

    await writeFile(filepath, JSON.stringify(ads, null, 2), 'utf-8');
    workerLogger.info(`[Worker] Saved: ${filename}`);
  }

  async _saveToDatabase(jobId, ads, jobManager) {
    const storage = new SupabaseStorage(config.SUPABASE_URL, config.SUPABASE_KEY);

    try {
      const progressCallback = async (current, total, success, failed) => {
        await jobManager.updateProgress(jobId, {
          inserted: success,
          failed,
          pending: total - (success + failed),
        });
      };

      const result = await storage.saveRawAdsBatch(ads, progressCallback);
      return result;
    } catch (error) {
      workerLogger.error(`[Worker] Save to DB error: ${error.message}`);
      return { success: 0, failed: ads.length, error: error.message };
    } finally {
      storage.close();
    }
  }

  async markUserRequestComplete(pageId) {
    try {
      const url = `${config.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/ads_scrape_request`;
      const headers = {
        apikey: config.SUPABASE_KEY,
        Authorization: `Bearer ${config.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      };
      const params = { page_id: `eq.${pageId}` };
      const data = { complete: true };

      const response = await axios.patch(url, data, {
        headers,
        params,
        timeout: 10000,
      });

      if (response.status === 200 || response.status === 204) {
        workerLogger.info(`[Worker] Marked user_request complete for page_id: ${pageId}`);
      } else {
        workerLogger.warn(`[Worker] Failed to mark user_request complete: ${response.status}`);
      }
    } catch (error) {
      workerLogger.error(`[Worker] Error marking user_request complete: ${error.message}`);
    }
  }

  async createUserBrandAndNotification(pageId) {
    try {
      const baseUrl = config.SUPABASE_URL.replace(/\/$/, '');
      const headers = {
        apikey: config.SUPABASE_KEY,
        Authorization: `Bearer ${config.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      };

      // Get the user_request to get user_id and created_at
      const requestUrl = `${baseUrl}/rest/v1/ads_scrape_request`;
      const requestParams = {
        page_id: `eq.${pageId}`,
        select: 'id,user_id,created_at',
      };

      const requestResponse = await axios.get(requestUrl, {
        headers,
        params: requestParams,
        timeout: 10000,
      });

      if (requestResponse.status !== 200) {
        workerLogger.warn(`[Worker] Failed to get user_request for page_id: ${pageId}`);
        return;
      }

      const requestsData = requestResponse.data;
      if (!requestsData || requestsData.length === 0) {
        workerLogger.warn(`[Worker] No user_request found for page_id: ${pageId}`);
        return;
      }

      const requestData = requestsData[0];
      const userId = requestData.user_id;
      const createdAt = requestData.created_at;

      if (!userId) {
        workerLogger.warn(`[Worker] No user_id in user_request for page_id: ${pageId}`);
        return;
      }

      // Get brand by platform_id (page_id)
      const brandsUrl = `${baseUrl}/rest/v1/brands`;
      const brandParams = {
        platform_id: `eq.${pageId}`,
        select: 'id,name',
      };

      const brandResponse = await axios.get(brandsUrl, {
        headers,
        params: brandParams,
        timeout: 10000,
      });

      if (brandResponse.status !== 200) {
        workerLogger.warn(`[Worker] Failed to get brand for page_id: ${pageId}`);
        return;
      }

      const brands = brandResponse.data;
      if (!brands || brands.length === 0) {
        workerLogger.warn(`[Worker] No brand found for page_id: ${pageId}`);
        return;
      }

      const brand = brands[0];
      const brandId = brand.id;
      const brandName = brand.name || 'Unknown Brand';

      // Check if user_brand relationship already exists
      const userBrandUrl = `${baseUrl}/rest/v1/user_brand`;
      const checkParams = {
        user_id: `eq.${userId}`,
        brand_id: `eq.${brandId}`,
        select: 'id',
      };

      const checkResponse = await axios.get(userBrandUrl, {
        headers,
        params: checkParams,
        timeout: 10000,
      });

      // Create user_brand relationship if it doesn't exist
      if (checkResponse.status === 200) {
        const existing = checkResponse.data;
        if (!existing || existing.length === 0) {
          // Insert user_brand relationship with last_scrap = created_at
          const insertData = {
            user_id: userId,
            brand_id: brandId,
            last_scrap: createdAt, // Set to request's created_at date
          };

          const insertResponse = await axios.post(userBrandUrl, insertData, {
            headers,
            timeout: 10000,
          });

          if (insertResponse.status === 200 || insertResponse.status === 201) {
            workerLogger.info(
              `[Worker] Created user_brand relationship for user_id: ${userId}, brand_id: ${brandId}, last_scrap: ${createdAt}`
            );
          } else {
            workerLogger.warn(
              `[Worker] Failed to create user_brand relationship: ${insertResponse.status} - ${JSON.stringify(insertResponse.data)}`
            );
          }
        } else {
          workerLogger.info(`[Worker] user_brand relationship already exists`);
        }
      }

      // Create notification
      const notificationUrl = `${baseUrl}/rest/v1/user_notification_v2`;
      const notificationData = {
        user_id: userId,
        message: `Your ad scrape request for ${brandName} has been completed`,
      };

      const notificationResponse = await axios.post(notificationUrl, notificationData, {
        headers,
        timeout: 10000,
      });

      if (notificationResponse.status === 200 || notificationResponse.status === 201) {
        workerLogger.info(`[Worker] Created notification for user_id: ${userId}`);
      } else {
        workerLogger.warn(
          `[Worker] Failed to create notification: ${notificationResponse.status} - ${JSON.stringify(notificationResponse.data)}`
        );
      }

      // Return userId for use in updateUserBrandLastScrap
      return userId;
    } catch (error) {
      workerLogger.error(`[Worker] Error creating user_brand and notification: ${error.message}`);
      if (error.response) {
        workerLogger.error(`[Worker] Response: ${JSON.stringify(error.response.data)}`);
      }
      return null;
    }
  }

  async updateUserBrandLastScrap(pageId, userId) {
    try {
      const baseUrl = config.SUPABASE_URL.replace(/\/$/, '');
      const headers = {
        apikey: config.SUPABASE_KEY,
        Authorization: `Bearer ${config.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      };

      // First, find the brand_id from page_id (platform_id in brands table)
      const brandsUrl = `${baseUrl}/rest/v1/brands`;
      const brandParams = {
        platform_id: `eq.${pageId}`,
        select: 'id',
      };

      const brandResponse = await axios.get(brandsUrl, {
        headers,
        params: brandParams,
        timeout: 10000,
      });

      if (brandResponse.status !== 200) {
        workerLogger.warn(`[Worker] Failed to find brand for page_id: ${pageId}`);
        return;
      }

      const brands = brandResponse.data;
      if (!brands || brands.length === 0) {
        workerLogger.warn(`[Worker] No brand found for page_id: ${pageId}`);
        return;
      }

      const brandId = brands[0].id;

      // Update user_brand.last_scrap for the specific user_id and brand_id relationship
      const userBrandUrl = `${baseUrl}/rest/v1/user_brand`;
      const userBrandParams = {
        user_id: `eq.${userId}`,
        brand_id: `eq.${brandId}`,
      };
      const currentTime = new Date().toISOString();
      const updateData = { last_scrap: currentTime };

      const updateResponse = await axios.patch(userBrandUrl, updateData, {
        headers,
        params: userBrandParams,
        timeout: 10000,
      });

      if (updateResponse.status === 200 || updateResponse.status === 204) {
        workerLogger.info(
          `[Worker] Updated user_brand.last_scrap for user_id: ${userId}, brand_id: ${brandId}`
        );
      } else {
        workerLogger.warn(`[Worker] Failed to update user_brand.last_scrap: ${updateResponse.status}`);
      }
    } catch (error) {
      workerLogger.error(`[Worker] Error updating user_brand.last_scrap: ${error.message}`);
      if (error.response) {
        workerLogger.error(`[Worker] Response: ${JSON.stringify(error.response.data)}`);
      }
    }
  }
}

// Main entry point
async function main() {
  workerLogger.info('='.repeat(60));
  workerLogger.info('Starting Spider Worker...');
  workerLogger.info('='.repeat(60));

  const redisAvailable = await checkRedisConnection();
  if (!redisAvailable) {
    workerLogger.error('Redis not available!');
    workerLogger.error('Start Redis first: redis-server');
    workerLogger.error('Worker will exit. Please start Redis and restart the worker.');
    process.exit(1);
  }

  workerLogger.info('Redis connection verified. Starting worker...');

  const worker = new SpiderWorker();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    workerLogger.info('\n[Worker] Shutting down...');
    worker.running = false;
    setTimeout(() => process.exit(0), 5000);
  });

  process.on('SIGTERM', () => {
    workerLogger.info('\n[Worker] Shutting down...');
    worker.running = false;
    setTimeout(() => process.exit(0), 5000);
  });

  // Start the worker loop
  workerLogger.info('Entering worker main loop...');
  await worker.run();
}

main().catch((error) => {
  workerLogger.error(`[Worker] Fatal error: ${error.message}`);
  workerLogger.error(`[Worker] Stack: ${error.stack}`);
  process.exit(1);
});
