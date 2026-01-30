import express from 'express';
import axios from 'axios';
import config from '../config/index.js';
import { apiLogger, logException } from '../core/logger.js';

const router = express.Router();

function getSupabaseConfig() {
  if (!config.SUPABASE_URL || !config.SUPABASE_KEY) {
    return null;
  }

  return {
    url: config.SUPABASE_URL.replace(/\/$/, ''),
    key: config.SUPABASE_KEY,
    headers: {
      apikey: config.SUPABASE_KEY,
      Authorization: `Bearer ${config.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  };
}

router.get('/', async (req, res) => {
  try {
    const supabaseConfig = getSupabaseConfig();
    if (!supabaseConfig) {
      apiLogger.warn('[API] Supabase not configured, returning empty list');
      return res.json({ requests: [] });
    }

    // Query ads_scrape_request table
    const url = `${supabaseConfig.url}/rest/v1/ads_scrape_request`;
    const params = {
      select: 'id,created_at,url,page_id,complete,user_id',
      order: 'created_at.desc',
    };

    const response = await axios.get(url, {
      headers: supabaseConfig.headers,
      params,
      timeout: 30000,
    });

    if (response.status !== 200) {
      apiLogger.error(`[API] Supabase query failed: ${response.status} - ${response.data}`);
      return res.json({ requests: [] });
    }

    const requestsData = response.data;

    // Get unique user IDs
    const userIds = [...new Set(requestsData.map((r) => r.user_id).filter(Boolean))];

    // Fetch user profiles if we have user IDs
    let usersMap = {};
    if (userIds.length > 0) {
      try {
        const userUrl = `${supabaseConfig.url}/rest/v1/user_profiles`;
        const userParams = {
          select: 'id,name,email',
          id: `in.(${userIds.join(',')})`,
        };
        const userResponse = await axios.get(userUrl, {
          headers: supabaseConfig.headers,
          params: userParams,
          timeout: 30000,
        });

        if (userResponse.status === 200) {
          const users = userResponse.data;
          usersMap = users.reduce((acc, u) => {
            acc[u.id] = u;
            return acc;
          }, {});
        }
      } catch (error) {
        apiLogger.warn(`[API] Error fetching user profiles: ${error.message}`);
      }
    }

    // Transform the data to include user names and last_scrap
    const requests = [];
    for (const item of requestsData) {
      const requestData = {
        id: item.id,
        created_at: item.created_at,
        url: item.url,
        page_id: item.page_id,
        complete: item.complete || false,
        user_id: item.user_id,
      };

      // Add user info if available
      const userId = item.user_id;
      if (userId && usersMap[userId]) {
        requestData.user_name = usersMap[userId].name || 'Unknown User';
        requestData.user_email = usersMap[userId].email;
      } else {
        requestData.user_name = 'Unknown User';
      }

      // Get last_scrap from user_brand table
      const pageId = item.page_id;
      if (pageId && userId) {
        try {
          // First, find brand_id from page_id (platform_id in brands table)
          const brandsUrl = `${supabaseConfig.url}/rest/v1/brands`;
          const brandParams = {
            platform_id: `eq.${pageId}`,
            select: 'id',
          };
          const brandResponse = await axios.get(brandsUrl, {
            headers: supabaseConfig.headers,
            params: brandParams,
            timeout: 30000,
          });

          if (brandResponse.status === 200) {
            const brands = brandResponse.data;
            if (brands && brands.length > 0) {
              const brandId = brands[0].id;

              // Now find user_brand relationship
              const userBrandUrl = `${supabaseConfig.url}/rest/v1/user_brand`;
              const userBrandParams = {
                brand_id: `eq.${brandId}`,
                user_id: `eq.${userId}`,
                select: 'last_scrap',
              };
              const userBrandResponse = await axios.get(userBrandUrl, {
                headers: supabaseConfig.headers,
                params: userBrandParams,
                timeout: 30000,
              });

              if (userBrandResponse.status === 200) {
                const userBrands = userBrandResponse.data;
                if (userBrands && userBrands.length > 0 && userBrands[0].last_scrap) {
                  requestData.last_scrap = userBrands[0].last_scrap;
                }
              }
            }
          }
        } catch (error) {
          logException(apiLogger, error, `[API] Error fetching last_scrap for request ${item.id}`);
        }
      }

      requests.push(requestData);
    }

    apiLogger.info(`[API] Returning ${requests.length} user requests`);
    res.json({ requests });
  } catch (error) {
    logException(apiLogger, error, '[API] Error fetching user requests');
    res.json({ requests: [] });
  }
});

router.get('/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const supabaseConfig = getSupabaseConfig();
    
    if (!supabaseConfig) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    // Get the request
    const url = `${supabaseConfig.url}/rest/v1/ads_scrape_request`;
    const params = {
      id: `eq.${requestId}`,
      select: 'id,created_at,url,page_id,complete,user_id',
    };

    const response = await axios.get(url, {
      headers: supabaseConfig.headers,
      params,
      timeout: 30000,
    });

    if (response.status !== 200) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const requestsData = response.data;
    if (!requestsData || requestsData.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const item = requestsData[0];

    // Get user info if available
    let userName = 'Unknown User';
    let userEmail = null;
    if (item.user_id) {
      try {
        const userUrl = `${supabaseConfig.url}/rest/v1/user_profiles`;
        const userParams = {
          id: `eq.${item.user_id}`,
          select: 'id,name,email',
        };
        const userResponse = await axios.get(userUrl, {
          headers: supabaseConfig.headers,
          params: userParams,
          timeout: 30000,
        });

        if (userResponse.status === 200) {
          const users = userResponse.data;
          if (users && users.length > 0) {
            userName = users[0].name || 'Unknown User';
            userEmail = users[0].email;
          }
        }
      } catch (error) {
        apiLogger.warn(`[API] Error fetching user profile: ${error.message}`);
      }
    }

    // Get last_scrap from user_brand table
    let lastScrap = null;
    const pageId = item.page_id;
    const userId = item.user_id;
    if (pageId && userId) {
      try {
        // Find brand_id from page_id (platform_id in brands table)
        const brandsUrl = `${supabaseConfig.url}/rest/v1/brands`;
        const brandParams = {
          platform_id: `eq.${pageId}`,
          select: 'id',
        };
        const brandResponse = await axios.get(brandsUrl, {
          headers: supabaseConfig.headers,
          params: brandParams,
          timeout: 30000,
        });

        if (brandResponse.status === 200) {
          const brands = brandResponse.data;
          if (brands && brands.length > 0) {
            const brandId = brands[0].id;

            // Find user_brand relationship
            const userBrandUrl = `${supabaseConfig.url}/rest/v1/user_brand`;
            const userBrandParams = {
              brand_id: `eq.${brandId}`,
              user_id: `eq.${userId}`,
              select: 'last_scrap',
            };
            const userBrandResponse = await axios.get(userBrandUrl, {
              headers: supabaseConfig.headers,
              params: userBrandParams,
              timeout: 30000,
            });

            if (userBrandResponse.status === 200) {
              const userBrands = userBrandResponse.data;
              if (userBrands && userBrands.length > 0 && userBrands[0].last_scrap) {
                lastScrap = userBrands[0].last_scrap;
              }
            }
          }
        }
      } catch (error) {
        logException(apiLogger, error, `[API] Error fetching last_scrap for request ${requestId}`);
      }
    }

    res.json({
      id: item.id,
      created_at: item.created_at,
      url: item.url,
      page_id: item.page_id,
      complete: item.complete || false,
      user_id: item.user_id,
      user_name: userName,
      user_email: userEmail,
      last_scrap: lastScrap,
    });
  } catch (error) {
    apiLogger.error(`[API] Error getting user request: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { url, page_id, user_id } = req.body;
    const supabaseConfig = getSupabaseConfig();

    if (!supabaseConfig) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const data = {
      url,
      page_id,
      user_id,
      complete: false,
    };

    const requestUrl = `${supabaseConfig.url}/rest/v1/ads_scrape_request`;
    const response = await axios.post(requestUrl, data, {
      headers: supabaseConfig.headers,
      timeout: 30000,
    });

    if (response.status !== 200 && response.status !== 201) {
      return res.status(500).json({ error: `Failed to create request: ${JSON.stringify(response.data)}` });
    }

    const responseData = response.data;
    let requestId = null;

    if (Array.isArray(responseData) && responseData.length > 0) {
      requestId = responseData[0].id;
    } else if (responseData && responseData.id) {
      requestId = responseData.id;
    }

    res.json({
      message: 'Request created successfully',
      id: requestId,
    });
  } catch (error) {
    apiLogger.error(`[API] Error creating user request: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/:requestId/complete', async (req, res) => {
  try {
    const { requestId } = req.params;
    const supabaseConfig = getSupabaseConfig();

    if (!supabaseConfig) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const url = `${supabaseConfig.url}/rest/v1/ads_scrape_request`;
    const params = {
      id: `eq.${requestId}`,
    };
    const data = {
      complete: true,
    };

    const response = await axios.patch(url, data, {
      headers: supabaseConfig.headers,
      params,
      timeout: 30000,
    });

    if (response.status !== 200 && response.status !== 204) {
      return res.status(404).json({ error: 'Request not found' });
    }

    res.json({ message: 'Request marked as complete' });
  } catch (error) {
    apiLogger.error(`[API] Error marking request complete: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const supabaseConfig = getSupabaseConfig();

    if (!supabaseConfig) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const url = `${supabaseConfig.url}/rest/v1/ads_scrape_request`;
    const params = {
      id: `eq.${requestId}`,
    };

    await axios.delete(url, {
      headers: supabaseConfig.headers,
      params,
      timeout: 30000,
    });

    res.json({ message: 'Request deleted successfully' });
  } catch (error) {
    apiLogger.error(`[API] Error deleting user request: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
