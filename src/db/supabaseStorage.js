import axios from 'axios';
import crypto from 'crypto';
import config from '../config/index.js';
import { workerLogger } from '../core/logger.js';

export class SupabaseStorage {
  constructor(url, key) {
    this.url = url.replace(/\/$/, '');
    this.key = key;
    this.headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    this.client = axios.create({
      baseURL: this.url,
      timeout: 120000,
      headers: this.headers,
    });
    this.assetsBucket = 'assets';
  }

  async saveRawAdsBatch(ads, progressCallback = null) {
    let success = 0;
    let failed = 0;
    const total = ads.length;

    workerLogger.info('='.repeat(60));
    workerLogger.info(`[DB] Saving ${total} raw ads with analysis...`);
    workerLogger.info('='.repeat(60));

    if (!ads || ads.length === 0) {
      return { success: 0, failed: 0, ad_ids: [] };
    }

    // Get brand from first ad
    const firstAd = ads[0];
    const firstSnapshot = firstAd.snapshot || {};
    const pageName = firstAd.page_name || 'Unknown';
    const pageId = String(firstAd.page_id || '');

    // Get logo URL from first ad's snapshot
    const logoUrl = firstSnapshot.page_profile_picture_url;

    const brandData = {
      name: pageName,
      platform_id: pageId,
      platform: 'facebook',
      logo_url: logoUrl,
      platform_url: firstSnapshot.page_profile_uri,
      category: firstSnapshot.page_categories?.[0] || null,
    };

    const brand = await this.createOrUpdateBrand(brandData);
    if (!brand) {
      return { success: 0, failed: total, error: 'Failed to create brand' };
    }

    const brandId = brand.id;
    const adIds = [];

    for (let i = 0; i < ads.length; i++) {
      try {
        workerLogger.info(`[DB] ===== AD ${i + 1}/${total} =====`);
        const adId = await this.saveRawAd(ads[i], brandId);
        if (adId) {
          success++;
          adIds.push(adId);
        } else {
          failed++;
        }

        if (progressCallback && (i + 1) % 5 === 0) {
          progressCallback(i + 1, total, success, failed);
        }
      } catch (error) {
        failed++;
        workerLogger.error(`[DB] Failed to save ad ${i + 1}: ${error.message}`);
        if (error.response) {
          workerLogger.error(`[DB] Status: ${error.response.status}`);
          workerLogger.error(`[DB] Response: ${JSON.stringify(error.response.data, null, 2)}`);
          workerLogger.error(`[DB] Request URL: ${error.config?.url}`);
        }
      }
    }

    workerLogger.info('='.repeat(60));
    workerLogger.info(`[DB] COMPLETE! Success: ${success}, Failed: ${failed}`);
    workerLogger.info('='.repeat(60));

    return { success, failed, ad_ids: adIds, brand_id: brandId };
  }

  async saveRawAd(rawAd, brandId = null) {
    try {
      const snapshot = rawAd.snapshot || {};
      const analysis = rawAd.analysis;

      // Build ad_data from raw
      const body = snapshot.body || {};
      const adCopy = typeof body === 'object' && body.text ? body.text : (body ? String(body) : '');

      // Get publisher platforms - handle both key names
      const publisherPlatforms = rawAd.publisher_platform || rawAd.publisher_platforms || [];

      // Get countries - handle both key names
      const countries = rawAd.targeted_or_reached_countries || rawAd.countries || [];

      const adData = {
        platform_id: String(rawAd.ad_archive_id || ''),
        ad_copy: adCopy.substring(0, 10000), // Limit length
        cta_type: snapshot.cta_type,
        cta_text: snapshot.cta_text,
        cta_link: snapshot.link_url,
        live_status: rawAd.is_active ? 'active' : 'inactive',
        country_code: Array.isArray(countries) ? countries.filter(Boolean) : (countries ? [countries] : []),
        categories: rawAd.categories || [],
        publisher_platforms: Array.isArray(publisherPlatforms)
          ? publisherPlatforms.filter(Boolean)
          : publisherPlatforms
          ? [publisherPlatforms]
          : [],
        raw_data: rawAd, // Store complete raw data
      };

      // Parse dates
      if (rawAd.start_date) {
        if (typeof rawAd.start_date === 'number') {
          adData.start_date = new Date(rawAd.start_date * 1000).toISOString();
        } else {
          adData.start_date = rawAd.start_date;
        }
      }

      if (rawAd.end_date) {
        if (typeof rawAd.end_date === 'number') {
          adData.end_date = new Date(rawAd.end_date * 1000).toISOString();
        } else {
          adData.end_date = rawAd.end_date;
        }
      }

      // Get or create brand if not provided
      if (!brandId) {
        const pageName = rawAd.page_name || 'Unknown';
        const pageId = String(rawAd.page_id || '');
        const logoUrl = snapshot.page_profile_picture_url;

        const brandData = {
          name: pageName,
          platform_id: pageId,
          platform: 'facebook',
          logo_url: logoUrl,
          platform_url: snapshot.page_profile_uri,
          category: snapshot.page_categories?.[0] || null,
        };

        const brand = await this.createOrUpdateBrand(brandData);
        if (!brand) {
          return null;
        }
        brandId = brand.id;
      }

      // Add brand_id
      adData.brand_id = brandId;

      // Add hash_value
      adData.hash_value = this._hashValue({ platform_id: adData.platform_id });

      // Add analysis fields if present
      if (analysis) {
        workerLogger.debug(`[DB] Analysis found for ad ${adData.platform_id.substring(0, 8)}...`);
        workerLogger.debug(`[DB] Analysis keys: ${Object.keys(analysis).join(', ')}`);
        this._addAnalysisToAdData(adData, analysis);
        workerLogger.debug(`[DB] After adding analysis, adData has keys: ${Object.keys(adData).join(', ')}`);
      } else {
        workerLogger.warn(`[DB] No analysis found for ad ${adData.platform_id.substring(0, 8)}...`);
      }

      // Remove None/null values but keep empty arrays
      const cleanedData = {};
      for (const [key, value] of Object.entries(adData)) {
        if (value !== null && value !== undefined) {
          cleanedData[key] = value;
        }
      }

      // Try to save ad
      try {
        workerLogger.debug(`[DB] Attempting to save ad with platform_id: ${adData.platform_id}`);
        workerLogger.debug(`[DB] Ad data keys: ${Object.keys(cleanedData).join(', ')}`);
        
        const response = await this.client.post('/rest/v1/ads', cleanedData);
        const result = Array.isArray(response.data) ? response.data[0] : response.data;
        const adId = result?.id;

        if (adId) {
          workerLogger.info(`[DB] Created ad: ${adId}`);

          // Save assets
          await this._saveAssets(adId, snapshot);

          // Update status
          await this.updateAdStatus(adId, 'completed');
          return adId;
        }
      } catch (error) {
        workerLogger.error(`[DB] Ad save failed: ${error.message}`);
        if (error.response) {
          workerLogger.error(`[DB] Status: ${error.response.status}`);
          workerLogger.error(`[DB] Response data: ${JSON.stringify(error.response.data, null, 2)}`);
          workerLogger.error(`[DB] Request data keys: ${Object.keys(cleanedData).join(', ')}`);
          // Log problematic fields
          for (const [key, value] of Object.entries(cleanedData)) {
            if (value && typeof value === 'object' && !Array.isArray(value) && value.constructor === Object) {
              workerLogger.error(`[DB] Field ${key} is object: ${JSON.stringify(value).substring(0, 200)}`);
            }
          }
        }

        // Retry without raw_data and analysis_raw (they can be large)
        const retryData = { ...cleanedData };
        delete retryData.raw_data;
        delete retryData.analysis_raw;

        try {
          const retryResponse = await this.client.post('/rest/v1/ads', retryData);
          const retryResult = Array.isArray(retryResponse.data) ? retryResponse.data[0] : retryResponse.data;
          const retryAdId = retryResult?.id;

          if (retryAdId) {
            workerLogger.info(`[DB] Created ad (without raw_data): ${retryAdId}`);
            await this.updateAdStatus(retryAdId, 'completed');
            return retryAdId;
          }
        } catch (retryError) {
          workerLogger.error(`[DB] Retry also failed: ${retryError.message}`);
          if (retryError.response) {
            workerLogger.error(`[DB] Retry response: ${JSON.stringify(retryError.response.data)}`);
          }
        }
      }

      return null;
    } catch (error) {
      workerLogger.error(`[DB] Error saving raw ad: ${error.message}`);
      if (error.response) {
        workerLogger.error(`[DB] Response: ${JSON.stringify(error.response.data)}`);
      }
      return null;
    }
  }

  _addAnalysisToAdData(adData, analysis) {
    if (!analysis) {
      return;
    }

    // Hook - only add if hook exists and has content (for video ads only)
    const hook = analysis.hook;
    if (hook && typeof hook === 'object' && (hook.text || hook.audio_hook || hook.visual_hook || hook.hook_text)) {
      const hookText =
        hook.text || hook.audio_hook || hook.visual_hook || hook.hook_text;
      if (hookText) {
        adData.hook_text = String(hookText).substring(0, 2000);
      }
      if (hook.type) {
        adData.hook_type = hook.type;
      }

      const hookScore = hook.score;
      if (hookScore !== null && hookScore !== undefined) {
        adData.hook_score = Math.round(Number(hookScore));
      }

      if (hook.visual_hook) {
        adData.visual_hook = String(hook.visual_hook).substring(0, 2000);
      }
    }

    // Headline - add if headline exists and has content (for both image and video ads)
    const headline = analysis.headline;
    if (headline) {
      if (typeof headline === 'object' && (headline.primary || headline.headline || headline.secondary)) {
        if (headline.primary || headline.headline) {
          adData.headline_primary = headline.primary || headline.headline;
        }
        if (headline.secondary) {
          adData.headline_secondary = headline.secondary;
        }
      } else if (typeof headline === 'string' && headline.trim()) {
        adData.headline_primary = headline;
      }
    }

    // Persona - only add if persona exists and has content (for video ads only)
    const persona = analysis.persona;
    if (persona && typeof persona === 'object' && (persona.age_range || persona.gender || persona.summary || persona.interests || persona.pain_points || persona.desires)) {
      if (persona.age_range) {
        adData.persona_age_range = persona.age_range;
      }
      if (persona.gender) {
        adData.persona_gender = persona.gender;
      }

      if (Array.isArray(persona.interests) && persona.interests.length > 0) {
        adData.persona_interests = persona.interests.filter(Boolean).map(String);
      }

      if (Array.isArray(persona.pain_points) && persona.pain_points.length > 0) {
        adData.persona_pain_points = persona.pain_points.filter(Boolean).map(String);
      }

      if (Array.isArray(persona.desires) && persona.desires.length > 0) {
        adData.persona_desires = persona.desires.filter(Boolean).map(String);
      }

      if (persona.summary) {
        adData.persona_summary = persona.summary;
      }
    }

    // Ad copy analysis
    const copyAnalysis = analysis.ad_copy_analysis || {};
    if (copyAnalysis && typeof copyAnalysis === 'object') {
      adData.copy_emotion = copyAnalysis.emotion;
      adData.copy_tone = copyAnalysis.tone;
      adData.copy_summary = copyAnalysis.summary;
    }

    // Scores
    const scores = analysis.scores || {};
    if (scores && typeof scores === 'object') {
      const hookScoreVal = scores.hook_strength || scores.hook;
      if (hookScoreVal !== null && hookScoreVal !== undefined) {
        adData.score_hook = Math.round(Number(hookScoreVal));
      }

      const clarityVal = scores.clarity;
      if (clarityVal !== null && clarityVal !== undefined) {
        adData.score_clarity = Math.round(Number(clarityVal));
      }

      const overallVal = scores.overall;
      if (overallVal !== null && overallVal !== undefined) {
        adData.score_overall = Math.round(Number(overallVal));
      }
    }

    // Analysis meta
    adData.analysis_mode = analysis.analysis_mode;

    if (Array.isArray(analysis.media_types_analyzed)) {
      adData.media_types_analyzed = analysis.media_types_analyzed.filter(Boolean).map(String);
    }

    if (analysis.analyzed_at) {
      adData.analyzed_at = analysis.analyzed_at;
    }

    // Full analysis JSON backup
    adData.analysis_raw = analysis;
  }

  async _saveAssets(adId, snapshot) {
    const images = snapshot.images || [];
    const videos = snapshot.videos || [];
    const cards = snapshot.cards || [];

    const assetsToSave = [];

    // Add images
    for (const img of images) {
      assetsToSave.push({
        media_type: 'image',
        thumbnail_url: img.resized_image_url,
        media_hd_url: img.original_image_url || img.resized_image_url,
      });
    }

    // Add videos
    for (const vid of videos) {
      assetsToSave.push({
        media_type: 'video',
        thumbnail_url: vid.video_preview_image_url,
        media_sd_url: vid.video_sd_url,
        media_hd_url: vid.video_hd_url,
      });
    }

    // Add carousel cards
    for (const card of cards) {
      assetsToSave.push({
        media_type: 'image',
        thumbnail_url: card.resized_image_url,
        media_hd_url: card.original_image_url || card.resized_image_url,
      });
    }

    // Save assets (limit to 5 per ad)
    if (assetsToSave.length > 0) {
      workerLogger.info(`[DB] Saving ${Math.min(assetsToSave.length, 5)} assets...`);
      for (let i = 0; i < Math.min(assetsToSave.length, 5); i++) {
        try {
          await this.createAdAsset(adId, assetsToSave[i]);
        } catch (error) {
          workerLogger.warn(`[DB] Failed to save asset ${i + 1}: ${error.message}`);
        }
      }
    }
  }

  async createAdAsset(adId, asset) {
    try {
      // Upload files to Supabase Storage
      const storagePath = `ads/${adId}`;
      
      let thumbnailPath = null;
      let mediaSdPath = null;
      let mediaHdPath = null;

      if (asset.thumbnail_url) {
        thumbnailPath = await this._uploadFileToStorage(
          this.assetsBucket,
          storagePath,
          asset.thumbnail_url
        );
      }

      if (asset.media_sd_url) {
        mediaSdPath = await this._uploadFileToStorage(
          this.assetsBucket,
          storagePath,
          asset.media_sd_url
        );
      }

      if (asset.media_hd_url) {
        mediaHdPath = await this._uploadFileToStorage(
          this.assetsBucket,
          storagePath,
          asset.media_hd_url
        );
      }

      // If no files were uploaded, skip creating asset
      if (!thumbnailPath && !mediaSdPath && !mediaHdPath) {
        workerLogger.warn(`[DB] No files uploaded, skipping asset`);
        return null;
      }

      const assetData = {
        ad_id: adId,
        media_type: asset.media_type || 'image',
        hash_value: this._hashValue({ ad_id: adId, hd: mediaHdPath }),
        thumbnail_url: thumbnailPath,
        media_sd_url: mediaSdPath,
        media_hd_url: mediaHdPath,
      };

      // Remove null/undefined values
      const cleanedAsset = {};
      for (const [key, value] of Object.entries(assetData)) {
        if (value !== null && value !== undefined) {
          cleanedAsset[key] = value;
        }
      }

      const response = await this.client.post('/rest/v1/assets', cleanedAsset);
      const result = Array.isArray(response.data) ? response.data[0] : response.data;
      workerLogger.info(`[DB] Created asset: ${result?.id}`);
      return result;
    } catch (error) {
      workerLogger.error(`[DB] Asset failed: ${error.message}`);
      if (error.response) {
        workerLogger.error(`[DB] Asset response: ${JSON.stringify(error.response.data)}`);
      }
      return null;
    }
  }

  async _uploadFileToStorage(bucket, path, remoteUrl) {
    if (!remoteUrl || !remoteUrl.startsWith('http')) {
      return null;
    }

    try {
      workerLogger.debug(`[Storage] Downloading: ${remoteUrl.substring(0, 60)}...`);

      // Download file
      const downloadResponse = await axios.get(remoteUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        maxRedirects: 5,
      });

      if (downloadResponse.status !== 200) {
        workerLogger.warn(`[Storage] Download failed: ${downloadResponse.status}`);
        return null;
      }

      const fileData = downloadResponse.data;
      if (!fileData || fileData.length < 100) {
        workerLogger.warn(`[Storage] File too small or empty`);
        return null;
      }

      const contentType = downloadResponse.headers['content-type'] || 'application/octet-stream';
      const ext = this._getExtension(contentType);
      const fileId = crypto.randomUUID().substring(0, 12);
      const storagePath = `${path}/${fileId}.${ext}`;

      workerLogger.debug(`[Storage] Uploading to: ${bucket}/${storagePath} (${fileData.length} bytes)`);

      // Upload to Supabase Storage
      const uploadUrl = `${this.url}/storage/v1/object/${bucket}/${storagePath}`;
      const uploadHeaders = {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        'Content-Type': contentType,
        'x-upsert': 'true',
      };

      const uploadResponse = await axios.post(uploadUrl, fileData, {
        headers: uploadHeaders,
        timeout: 120000,
      });

      if (uploadResponse.status === 200 || uploadResponse.status === 201) {
        workerLogger.info(`[Storage] Uploaded: ${storagePath}`);
        return storagePath;
      } else {
        workerLogger.warn(`[Storage] Upload failed: ${uploadResponse.status}`);
        return null;
      }
    } catch (error) {
      workerLogger.error(`[Storage] Error uploading file: ${error.message}`);
      return null;
    }
  }

  _getExtension(contentType) {
    if (!contentType) {
      return 'dat';
    }

    const ct = contentType.toLowerCase();
    if (ct.includes('jpeg') || ct.includes('jpg')) {
      return 'jpg';
    } else if (ct.includes('png')) {
      return 'png';
    } else if (ct.includes('gif')) {
      return 'gif';
    } else if (ct.includes('webp')) {
      return 'webp';
    } else if (ct.includes('video') || ct.includes('mp4')) {
      return 'mp4';
    } else if (ct.includes('octet-stream')) {
      return 'mp4';
    }
    return 'dat';
  }

  getPublicUrl(storagePath) {
    return `${this.url}/storage/v1/object/public/${this.assetsBucket}/${storagePath}`;
  }

  async updateAdStatus(adId, status) {
    try {
      await this.client.patch(`/rest/v1/ads`, { process_status: status }, {
        params: { id: `eq.${adId}` },
      });
    } catch (error) {
      workerLogger.warn(`[DB] Update status error: ${error.message}`);
    }
  }

  async createOrUpdateBrand(brandData) {
    try {
      const platformId = String(brandData.platform_id || '');
      
      // Try to get existing brand
      const response = await this.client.get('/rest/v1/brands', {
        params: {
          platform_id: `eq.${platformId}`,
          select: 'id,name,logo_url',
        },
      });

      if (response.data && response.data.length > 0) {
        const existing = response.data[0];
        
        // Check if logo is missing and we have a new one
        if (!existing.logo_url && brandData.logo_url) {
          workerLogger.info(`[DB] Brand has no logo, uploading now...`);
          const logoStoragePath = await this._uploadFileToStorage(
            this.assetsBucket,
            `brands/${platformId}`,
            brandData.logo_url
          );
          
          if (logoStoragePath) {
            try {
              await this.client.patch('/rest/v1/brands', { logo_url: logoStoragePath }, {
                params: { id: `eq.${existing.id}` },
              });
              workerLogger.info(`[DB] Brand logo updated: ${logoStoragePath}`);
              existing.logo_url = logoStoragePath;
            } catch (error) {
              workerLogger.warn(`[DB] Failed to update brand logo: ${error.message}`);
            }
          }
        }
        
        return existing;
      }

      // Create new brand - upload logo first
      let logoStoragePath = null;
      if (brandData.logo_url) {
        workerLogger.info(`[DB] Uploading brand logo...`);
        logoStoragePath = await this._uploadFileToStorage(
          this.assetsBucket,
          `brands/${platformId}`,
          brandData.logo_url
        );
        if (logoStoragePath) {
          workerLogger.info(`[DB] Logo uploaded: ${logoStoragePath}`);
        } else {
          workerLogger.warn(`[DB] Logo upload failed`);
        }
      }

      const cleanedBrand = {};
      for (const [key, value] of Object.entries(brandData)) {
        if (value !== null && value !== undefined && key !== 'logo_url') {
          cleanedBrand[key] = value;
        }
      }

      // Use storage path for logo instead of remote URL
      if (logoStoragePath) {
        cleanedBrand.logo_url = logoStoragePath;
      }

      // Add hash_value
      cleanedBrand.hash_value = this._hashValue(brandData);

      const createResponse = await this.client.post('/rest/v1/brands', cleanedBrand);
      return Array.isArray(createResponse.data) ? createResponse.data[0] : createResponse.data;
    } catch (error) {
      workerLogger.error(`[DB] Error getting/creating brand: ${error.message}`);
      if (error.response) {
        workerLogger.error(`[DB] Response: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  _hashValue(value) {
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return crypto.createHash('sha256').update(str).digest('hex').substring(0, 32);
  }

  close() {
    // Axios client doesn't need explicit cleanup
  }
}

export default SupabaseStorage;
