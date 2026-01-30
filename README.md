# Spider Backend - Node.js

Facebook Ad Library Scraper API - Converted from Python to Node.js

## Features

- ✅ Express.js REST API
- ✅ Redis-based job queue
- ✅ Apify Facebook Ad Scraper integration
- ✅ OpenAI GPT-4 analysis (text, image, video)
- ✅ Supabase database storage
- ✅ Winston logging with rotation
- ✅ Parallel worker processing
- ✅ Job progress tracking

## Installation

```bash
cd spider-backend-nodejs
npm install
```

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required environment variables:
- `APIFY_API_TOKEN` - Your Apify API token
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_KEY` - Your Supabase API key
- `OPENAI_API_KEY` - Your OpenAI API key
- `REDIS_URL` - Redis connection URL (default: redis://localhost:6379/0)

## Running

### Development (with auto-reload)

**Terminal 1 - API Server:**
```bash
npm run dev
```

**Terminal 2 - Worker:**
```bash
npm run dev:worker
```

### Production

**Terminal 1 - API Server:**
```bash
npm start
```

**Terminal 2 - Worker:**
```bash
npm run worker
```

### Run Both Together

```bash
npm run start:all
```

## API Endpoints

- `POST /api/jobs` - Create scraping job
- `GET /api/jobs/:jobId` - Get job status
- `GET /api/jobs` - List all jobs
- `POST /api/jobs/clear-completed` - Clear completed jobs
- `POST /api/jobs/clear-failed` - Clear failed jobs
- `GET /health` - Health check

## Project Structure

```
spider-backend-nodejs/
├── src/
│   ├── config/          # Configuration
│   ├── core/            # Core utilities (Redis, Logger)
│   ├── routes/           # API routes
│   ├── scraper/          # Apify scraper
│   ├── analyzer/         # OpenAI analyzer
│   ├── db/               # Supabase storage
│   ├── index.js          # Express app
│   └── worker.js         # Background worker
├── logs/                 # Log files
├── data/                 # Scraped JSON files
└── package.json
```

## Differences from Python Version

1. **Async/Await**: Uses native Node.js async/await instead of Python asyncio
2. **Redis**: Uses `redis` npm package (v4) with async/await
3. **HTTP Client**: Uses `axios` instead of `httpx`
4. **Logging**: Uses `winston` instead of Python logging
5. **Job Queue**: Uses Redis directly instead of RQ

## Notes

- Make sure Redis is running before starting the server/worker
- Logs are saved to `logs/` directory with daily rotation
- Scraped data is saved to `data/` directory as JSON files

## Migration Status

✅ Core infrastructure (config, logging, Redis)
✅ Apify scraper
✅ OpenAI analyzer
✅ Supabase storage (basic)
✅ Jobs API routes
✅ Worker system
⏳ Additional API routes (ads, dashboard, brands, user_requests, analysis, settings)

The core functionality is complete. Additional routes can be added as needed.
