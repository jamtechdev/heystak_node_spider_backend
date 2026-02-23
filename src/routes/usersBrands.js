import express from "express";
import axios from "axios";
import config from "../config/index.js";
import { apiLogger, logException } from "../core/logger.js";

const router = express.Router();

function getSupabaseConfig() {
  if (!config.SUPABASE_URL || !config.SUPABASE_KEY) {
    return null;
  }

  return {
    url: config.SUPABASE_URL.replace(/\/$/, ""),
    key: config.SUPABASE_KEY,
    headers: {
      apikey: config.SUPABASE_KEY,
      Authorization: `Bearer ${config.SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
  };
}

router.get("/", async (req, res) => {
  try {
    const supabaseConfig = getSupabaseConfig();

    if (!supabaseConfig) {
      return res.status(503).json({ error: "Database not configured" });
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || "";

    const userBrandUrl = `${supabaseConfig.url}/rest/v1/user_brand`;
    const userBrandParams = {
      select: "brand_id,last_scrap,ub_created_at:created_at,brands!inner(*)",
      order: "created_at.desc",
      limit,
      offset,
    };

    // Add search filter if search query exists
    if (search.trim()) {
      userBrandParams["brands.name"] = `ilike.*${search.trim()}*`;
    }

    // Add Prefer header to get total count in response headers
    const userBrandResponse = await axios.get(userBrandUrl, {
      headers: {
        ...supabaseConfig.headers,
        Prefer: "count=exact",
      },
      params: userBrandParams,
      timeout: 30000,
    });

    // Extract total count from Content-Range header
    const contentRange = userBrandResponse.headers["content-range"];
    const total = contentRange ? parseInt(contentRange.split("/")[1], 10) : 0;
    const totalPages = Math.ceil(total / limit);

    // Transform data to include brand details with user_brand metadata
    const data = userBrandResponse.data
      .filter((item) => item.brands) // Filter out any null brands
      .map((item) => ({
        ...item.brands,
        user_brand: {
          brand_id: item.brand_id,
          last_scrap: item.last_scrap,
          created_at: item.ub_created_at,
        },
      }));

    res.json({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasPrevPage: page > 1,
        hasNextPage: page < totalPages,
      },
      search: search.trim() || null,
    });
  } catch (error) {
    console.log(error);

    apiLogger.error(`[API] Error getting user brands: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
