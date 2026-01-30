import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '../..');

// Ensure data directory exists
const dataDir = join(rootDir, 'data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

export const config = {
  // App
  APP_NAME: process.env.APP_NAME || 'Spider',
  DEBUG: process.env.DEBUG === 'true',
  
  // Apify
  APIFY_API_TOKEN: process.env.APIFY_API_TOKEN || '',
  APIFY_ACTOR_ID: process.env.APIFY_ACTOR_ID || 'XtaWFhbtfxyzqrFmd',
  
  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_KEY: process.env.SUPABASE_KEY || '',
  
  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  
  // Redis
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379', 10),
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379/0',
  
  // Scraper
  MAX_BRANDS: parseInt(process.env.MAX_BRANDS || '5', 10),
  MAX_ADS_PER_BRAND: parseInt(process.env.MAX_ADS_PER_BRAND || '100', 10),
  HEADLESS: process.env.HEADLESS !== 'false',
  
  // Worker
  MAX_WORKERS: parseInt(process.env.MAX_WORKERS || '5', 10),
  ANALYSIS_WORKERS: parseInt(process.env.ANALYSIS_WORKERS || '10', 10),
  
  // Server
  PORT: parseInt(process.env.PORT || '8000', 10),
  
  // Data storage
  DATA_DIR: dataDir,
};

export default config;
