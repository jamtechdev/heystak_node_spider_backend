import express from 'express';
import cors from 'cors';
import config from './config/index.js';
import { checkRedisConnection } from './core/redis.js';
import { apiLogger } from './core/logger.js';
import jobsRouter from './routes/jobs.js';
import dashboardRouter from './routes/dashboard.js';
import userRequestsRouter from './routes/userRequests.js';
import adsRouter from './routes/ads.js';
import userBrands from "./routes/usersBrands.js";

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';

  apiLogger.info(`${req.method} ${req.path} - Client: ${clientIp}`);

  res.on('finish', () => {
    const processTime = ((Date.now() - startTime) / 1000).toFixed(3);
    apiLogger.info(`${req.method} ${req.path} - Status: ${res.statusCode} - Time: ${processTime}s`);
  });

  next();
});

// Routes
app.use('/api/jobs', jobsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/user-requests', userRequestsRouter);
app.use('/api/ads', adsRouter);
app.use('/api/users-brands',userBrands)

// Health check
app.get('/health', async (req, res) => {
  const redisAvailable = await checkRedisConnection();
  res.json({
    status: 'healthy',
    redis: redisAvailable,
    data_dir: config.DATA_DIR,
  });
});

// Root
app.get('/', (req, res) => {
  res.json({
    name: config.APP_NAME,
    description: 'Facebook Ad Library Scraper',
    docs: '/docs',
    endpoints: {
      create_job: 'POST /api/jobs/',
      job_status: 'GET /api/jobs/:jobId',
      list_jobs: 'GET /api/jobs',
    },
  });
});

// Error handler
app.use((err, req, res, next) => {
  apiLogger.error(`[API] Error: ${err.message}`, { error: err.stack });
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// Start server
const PORT = config.PORT;
app.listen(PORT, () => {
  apiLogger.info(`Server started on port ${PORT}`);
  apiLogger.info(`API available at http://localhost:${PORT}`);
});

export default app;
