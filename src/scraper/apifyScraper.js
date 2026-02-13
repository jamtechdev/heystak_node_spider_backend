import { ApifyClient } from 'apify-client';
import config from '../config/index.js';
import { workerLogger } from '../core/logger.js';

export class ApifyFacebookScraper {
  constructor(apiToken, actorId = null) {
    this.apiToken = apiToken;
    this.actorId = actorId || config.APIFY_ACTOR_ID;
    this.client = new ApifyClient({ token: apiToken });
  }

  async scrape(
    url,
    maxResults = 100,
    progressCallback = null,
    period = null,
    startDateFormatted = null,
    endDateFormatted = null
  ) {
    workerLogger.info('='.repeat(60));
    workerLogger.info('[Apify] Starting scraper...');
    workerLogger.info(`[Apify] URL: ${url}`);
    workerLogger.info(`[Apify] Max results: ${maxResults}`);
    workerLogger.info('='.repeat(60));

    if (progressCallback) {
      progressCallback(0, maxResults, 'Starting Apify actor...');
    }

    // Prepare input
    const runInput = {
      urls: [{ url }],
      count: maxResults,
      scrapeAdDetails: false,
      'scrapePageAds.activeStatus': 'all',
      'scrapePageAds.countryCode': 'ALL',
      'scrapePageAds.sortBy': 'most_recent'
    };

    // Add period filter if provided (takes precedence over date filters)
    if (period) {
      runInput.period = period;
      workerLogger.info(`[Apify] Using period filter: ${period}`);
    } else {
      // Add date filters if provided (format: YYYY-MM-DD)
      if (startDateFormatted) {
        runInput['scrapePageAds.startDate'] = startDateFormatted;
        workerLogger.info(`[Apify] Using start date filter: ${startDateFormatted}`);
      }
      if (endDateFormatted) {
        runInput['scrapePageAds.endDate'] = endDateFormatted;
        workerLogger.info(`[Apify] Using end date filter: ${endDateFormatted}`);
      }
    }

    workerLogger.info(`[Apify] Running actor: ${this.actorId}`);

    if (progressCallback) {
      progressCallback(0, maxResults, 'Starting Apify actor...');
    }

    let runId;
    let datasetId;

    try {
      // Run the actor (start without waiting)
      const run = await this.client.actor(this.actorId).call(runInput, { waitSecs: 0 });
      runId = run.id;
      datasetId = run.defaultDatasetId;
      workerLogger.info(`[Apify] Run started! Run ID: ${runId}`);
    } catch (error) {
      const errorMsg = error.message || String(error);
      
      // Check for specific Apify errors
      if (
        errorMsg.includes('Monthly usage hard limit exceeded') ||
        errorMsg.toLowerCase().includes('usage limit')
      ) {
        workerLogger.error('[Apify] Monthly usage limit exceeded');
        throw new Error('Apify monthly usage limit exceeded. Please upgrade your Apify plan or wait for the limit to reset.');
      } else if (errorMsg.toLowerCase().includes('rate limit')) {
        workerLogger.error('[Apify] Rate limit exceeded');
        throw new Error('Apify rate limit exceeded. Please try again later.');
      } else {
        workerLogger.error(`[Apify] Error: ${errorMsg}`);
        throw error;
      }
    }

    // Poll for completion
    if (progressCallback) {
      progressCallback(0, maxResults, 'Waiting for actor to complete...');
    }

    let runStatus;
    let pollCount = 0;
    const maxPolls = 3600; // 1 hour max (poll every second)

    while (pollCount < maxPolls) {
      try {
        const runInfo = await this.client.run(runId).get();
        runStatus = runInfo.status;

        if (runStatus === 'SUCCEEDED') {
          workerLogger.info('[Apify] Run completed successfully');
          break;
        } else if (runStatus === 'FAILED' || runStatus === 'ABORTED') {
          const errorMsg = runInfo.statusMessage || 'Actor run failed';
          workerLogger.error(`[Apify] Run failed: ${errorMsg}`);
          throw new Error(`Apify run failed: ${errorMsg}`);
        } else if (runStatus === 'RUNNING') {
          // Update progress if available
          if (runInfo.stats && runInfo.stats.itemsProcessed) {
            const processed = runInfo.stats.itemsProcessed;
            if (progressCallback) {
              progressCallback(processed, maxResults, `Processing... ${processed}/${maxResults}`);
            }
          }
        }

        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, 1000));
        pollCount++;
      } catch (pollError) {
        workerLogger.error(`[Apify] Polling error: ${pollError.message}`);
        throw pollError;
      }
    }

    if (pollCount >= maxPolls) {
      throw new Error('Apify run timed out after 1 hour');
    }

    // Fetch results from dataset
    if (progressCallback) {
      progressCallback(0, maxResults, 'Fetching results from dataset...');
    }

    try {
      const { items } = await this.client.dataset(datasetId).listItems();
      workerLogger.info(`[Apify] Fetched ${items.length} ads from dataset`);

      if (progressCallback) {
        progressCallback(items.length, items.length, 'Fetching complete');
      }

      return items;
    } catch (error) {
      workerLogger.error(`[Apify] Error fetching dataset: ${error.message}`);
      throw new Error(`Failed to fetch results: ${error.message}`);
    }
  }

  async close() {
    // Apify client doesn't need explicit cleanup
  }
}

export default ApifyFacebookScraper;
