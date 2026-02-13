import express from "express";
import { v4 as uuidv4 } from "uuid";
import { JobManager, checkRedisConnection } from "../core/redis.js";
import config from "../config/index.js";
import { apiLogger } from "../core/logger.js";
import multer from "multer";

const router = express.Router();

const upload = multer({
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "text/csv" || file.originalname.endsWith(".csv")) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are allowed"), false);
    }
  },
  dest: "uploads/",
});

function extractPageId(url) {
  const patterns = [/view_all_page_id=(\d+)/, /page_id=(\d+)/];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return "unknown";
}

router.post("/", async (req, res) => {
  try {
    // Check Redis
    const redisAvailable = await checkRedisConnection();
    if (!redisAvailable) {
      return res.status(503).json({ error: "Redis is not available" });
    }

    const {
      page_ids,
      max_ads_per_page,
      save_json,
      save_db,
      auto_analyze,
      analysis_mode,
      start_date_formatted,
      end_date_formatted,
      period,
    } = req.body;

    // Set default max_ads_per_page to config limit if not provided
    const maxAds =
      max_ads_per_page !== undefined && max_ads_per_page !== null
        ? parseInt(max_ads_per_page, 10)
        : config.MAX_ADS_PER_BRAND;

    // Validate
    if (page_ids.length > config.MAX_BRANDS) {
      return res
        .status(400)
        .json({ error: `Maximum ${config.MAX_BRANDS} pages allowed` });
    }

    // Skip max ads validation if date filters are provided
    if (!start_date_formatted && !end_date_formatted) {
      if (maxAds > config.MAX_ADS_PER_BRAND) {
        return res.status(400).json({
          error: `Maximum ${config.MAX_ADS_PER_BRAND} ads per page allowed`,
        });
      }
    }

    if (!page_ids || page_ids.length === 0) {
      return res.status(400).json({ error: "At least one page_id required" });
    }

    // Create job manager
    const jobManager = new JobManager();
    await jobManager.init();

    // Create job for each page_id
    const jobIds = [];
    for (const pageId of page_ids) {
      const jobId = uuidv4().substring(0, 8);
      const url = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&is_targeted_country=false&media_type=all&search_type=page&sort_data[mode]=relevancy_monthly_grouped&sort_data[direction]=desc&view_all_page_id=${pageId}`;

      await jobManager.createJob({
        job_id: jobId,
        url,
        max_ads: maxAds,
        save_json: save_json !== false,
        save_db: save_db !== false,
        auto_analyze: auto_analyze !== false,
        analysis_mode: analysis_mode || "balanced",
        page_id: pageId,
        start_date_formatted,
        end_date_formatted,
        period,
      });

      jobIds.push(jobId);
    }

    await jobManager.close();

    res.json({
      job_id: jobIds.join(","),
      status: "queued",
      message: `Created ${jobIds.length} job(s). Scraping ${page_ids.length} page(s) with up to ${maxAds} ads each.`,
    });
  } catch (error) {
    apiLogger.error(`[API] Error creating job: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "50", 10);
    const jobManager = new JobManager();
    await jobManager.init();

    const jobs = await jobManager.getAllJobs(limit);
    await jobManager.close();

    res.json({
      total: jobs.length,
      jobs,
    });
  } catch (error) {
    apiLogger.error(`[API] Error listing jobs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get("/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobManager = new JobManager();
    await jobManager.init();

    const job = await jobManager.getJob(jobId);
    await jobManager.close();

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const progress = job.progress || {};
    const status = job.status || "unknown";

    const statusMap = {
      queued: "queued",
      running: "processing",
      completed: "completed",
      failed: "failed",
      cancelled: "cancelled",
    };

    res.json({
      job_id: jobId,
      status: statusMap[status] || status,
      progress: progress.scraped || 0,
      page_ids: [extractPageId(job.url || "")],
      ads_count: progress.scraped || 0,
      file_path: null,
      error: job.error,
      created_at: job.created_at,
      completed_at: job.completed_at,
    });
  } catch (error) {
    apiLogger.error(`[API] Error getting job: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});
// Otherwise Express will match /clear-completed as /:jobId with jobId="clear-completed"

router.post("/clear-completed", async (req, res) => {
  try {
    const redisAvailable = await checkRedisConnection();
    if (!redisAvailable) {
      return res.status(503).json({ error: "Redis is not available" });
    }

    const jobManager = new JobManager();
    await jobManager.init();
    const count = await jobManager.clearCompleted();
    await jobManager.close();

    res.json({ message: `Cleared ${count} completed job(s)` });
  } catch (error) {
    apiLogger.error(`[API] Error clearing completed jobs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post("/clear-failed", async (req, res) => {
  try {
    const redisAvailable = await checkRedisConnection();
    if (!redisAvailable) {
      return res.status(503).json({ error: "Redis is not available" });
    }

    const jobManager = new JobManager();
    await jobManager.init();
    const count = await jobManager.clearFailed();
    await jobManager.close();

    res.json({ message: `Cleared ${count} failed job(s)` });
  } catch (error) {
    apiLogger.error(`[API] Error clearing failed jobs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post("/clear-cancelled", async (req, res) => {
  try {
    const redisAvailable = await checkRedisConnection();
    if (!redisAvailable) {
      return res.status(503).json({ error: "Redis is not available" });
    }

    const jobManager = new JobManager();
    await jobManager.init();
    const count = await jobManager.clearCancelled();
    await jobManager.close();

    res.json({ message: `Cleared ${count} cancelled job(s)` });
  } catch (error) {
    apiLogger.error(`[API] Error clearing cancelled jobs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.delete("/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobManager = new JobManager();
    await jobManager.init();

    const job = await jobManager.getJob(jobId);
    if (!job) {
      await jobManager.close();
      return res.status(404).json({ error: "Job not found" });
    }

    await jobManager.deleteJob(jobId);
    await jobManager.close();

    res.json({ message: `Job ${jobId} deleted` });
  } catch (error) {
    apiLogger.error(`[API] Error deleting job: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post("/:jobId/cancel", async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobManager = new JobManager();
    await jobManager.init();

    const job = await jobManager.getJob(jobId);
    if (!job) {
      await jobManager.close();
      return res.status(404).json({ error: "Job not found" });
    }

    await jobManager.cancelJob(jobId);
    await jobManager.close();

    res.json({ message: `Job ${jobId} cancelled` });
  } catch (error) {
    apiLogger.error(`[API] Error cancelling job: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post("/:jobId/requeue", async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobManager = new JobManager();
    await jobManager.init();

    const job = await jobManager.getJob(jobId);
    if (!job) {
      await jobManager.close();
      return res.status(404).json({ error: "Job not found" });
    }

    await jobManager.requeueJob(jobId);
    await jobManager.close();

    res.json({ message: `Job ${jobId} requeued` });
  } catch (error) {
    apiLogger.error(`[API] Error requeuing job: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post("/clear-queued", async (req, res) => {
  try {
    const redisAvailable = await checkRedisConnection();
    if (!redisAvailable) {
      return res.status(503).json({ error: "Redis is not available" });
    }

    const jobManager = new JobManager();
    await jobManager.init();
    const jobs = await jobManager.getAllJobs(1000);
    let count = 0;

    for (const job of jobs) {
      if (job.status === "queued" || job.status === "running") {
        await jobManager.deleteJob(job.job_id);
        count++;
      }
    }

    res.json({ message: `Cleared ${count} queued/running job(s)` });
  } catch (error) {
    apiLogger.error(`[API] Error clearing queued jobs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post("/bulk/delete", async (req, res) => {
  try {
    const redisAvailable = await checkRedisConnection();
    if (!redisAvailable) {
      return res.status(503).json({ error: "Redis is not available" });
    }

    const { job_ids } = req.body;
    if (!Array.isArray(job_ids)) {
      return res.status(400).json({ error: "job_ids must be an array" });
    }

    const jobManager = new JobManager();
    await jobManager.init();

    let deletedCount = 0;
    for (const jobId of job_ids) {
      const job = await jobManager.getJob(jobId);
      if (job) {
        await jobManager.deleteJob(jobId);
        deletedCount++;
      }
    }

    await jobManager.close();
    res.json({ message: `Deleted ${deletedCount} job(s)` });
  } catch (error) {
    apiLogger.error(`[API] Error bulk deleting jobs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post("/bulk/cancel", async (req, res) => {
  try {
    const redisAvailable = await checkRedisConnection();
    if (!redisAvailable) {
      return res.status(503).json({ error: "Redis is not available" });
    }

    const { job_ids } = req.body;
    if (!Array.isArray(job_ids)) {
      return res.status(400).json({ error: "job_ids must be an array" });
    }

    const jobManager = new JobManager();
    await jobManager.init();

    let cancelledCount = 0;
    for (const jobId of job_ids) {
      const job = await jobManager.getJob(jobId);
      if (job && (job.status === "queued" || job.status === "running")) {
        await jobManager.cancelJob(jobId);
        cancelledCount++;
      }
    }

    await jobManager.close();
    res.json({ message: `Cancelled ${cancelledCount} job(s)` });
  } catch (error) {
    apiLogger.error(`[API] Error bulk cancelling jobs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post("/bulk/requeue", async (req, res) => {
  try {
    const redisAvailable = await checkRedisConnection();
    if (!redisAvailable) {
      return res.status(503).json({ error: "Redis is not available" });
    }

    const { job_ids } = req.body;
    if (!Array.isArray(job_ids)) {
      return res.status(400).json({ error: "job_ids must be an array" });
    }

    const jobManager = new JobManager();
    await jobManager.init();

    let requeuedCount = 0;
    for (const jobId of job_ids) {
      const job = await jobManager.getJob(jobId);
      if (job && job.status === "failed") {
        await jobManager.requeueJob(jobId);
        requeuedCount++;
      }
    }

    await jobManager.close();
    res.json({ message: `Requeued ${requeuedCount} job(s)` });
  } catch (error) {
    apiLogger.error(`[API] Error bulk requeuing jobs: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post("/csv", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No CSV file uploaded" });
    }

    const fs = await import("fs");
    const csv = await import("csv-parser");

    const results = [];
    fs.createReadStream(req.file.path)
      .pipe(csv.default())
      .on("data", (data) => results.push(data))
      .on("end", async () => {
        fs.unlinkSync(req.file.path);

        const redisAvailable = await checkRedisConnection();
        if (!redisAvailable) {
          return res.status(503).json({ error: "Redis is not available" });
        }

        const {
          max_ads_per_page,
          save_json,
          save_db,
          auto_analyze,
          analysis_mode,
          start_date_formatted,
          end_date_formatted,
          period,
        } = req.body;

        const maxAds =
          max_ads_per_page !== undefined && max_ads_per_page !== null
            ? parseInt(max_ads_per_page, 10)
            : config.MAX_ADS_PER_BRAND;

        if (!start_date_formatted && !end_date_formatted) {
          if (maxAds > config.MAX_ADS_PER_BRAND) {
            return res.status(400).json({
              error: `Maximum ${config.MAX_ADS_PER_BRAND} ads per page allowed`,
            });
          }
        }

        if (results.length === 0) {
          return res.status(400).json({ error: "CSV file is empty" });
        }

        if (results.length > config.MAX_BRANDS) {
          return res
            .status(400)
            .json({ error: `Maximum ${config.MAX_BRANDS} pages allowed` });
        }

        const jobManager = new JobManager();
        await jobManager.init();

        const jobIds = [];
        for (const row of results) {
          let url = null;
          const keys = Object.keys(row);
          for (const key of keys) {
            if (key.includes("facebook.com/ads/library")) {
              url = row[key];
              break;
            }
          }

          if (!url) {
            continue;
          }

          const pageId = extractPageId(url);

          const jobId = uuidv4().substring(0, 8);

          await jobManager.createJob({
            job_id: jobId,
            url,
            max_ads: maxAds,
            save_json: save_json !== false,
            save_db: save_db !== false,
            auto_analyze: auto_analyze !== false,
            analysis_mode: analysis_mode || "balanced",
            page_id: pageId,
            start_date_formatted,
            end_date_formatted,
            period,
          });

          jobIds.push(jobId);
        }

        await jobManager.close();

        res.json({
          job_id: jobIds.join(","),
          status: "queued",
          message: `Created ${jobIds.length} job(s) from CSV with ${results.length} page(s). Scraping up to ${maxAds} ads each.`,
        });
      });
  } catch (error) {
    apiLogger.error(`[API] Error creating job from CSV: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
