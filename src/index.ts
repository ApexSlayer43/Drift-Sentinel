// ============================================================
// Drift Sentinel — Main Express Application
// ============================================================

import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import { config, validateConfig } from './config';
import { apiRateLimiter } from './middleware/rateLimit';

// Routes
import healthRouter from './routes/health';
import fillsRouter from './routes/fills';
import driftRouter from './routes/drift';
import webhooksRouter from './routes/webhooks';
import configRouter from './routes/config';

// Validate environment
validateConfig();

const app = express();

// --- Global middleware ---
app.use(helmet());
app.use(cors({
  origin: '*', // MVP: allow all origins (lock down for production)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Token'],
}));
app.use(express.json({ limit: '10mb' })); // CSV uploads can be large
app.use(apiRateLimiter);

// --- Routes ---
app.use('/', healthRouter);
app.use('/api/fills', fillsRouter);
app.use('/api/drift', driftRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/config', configRouter);

// --- 404 handler ---
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// --- Error handler ---
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- Start server ---
const server = http.createServer(app);
server.listen(config.port, () => {
  console.log(`Drift Sentinel backend running on port ${config.port}`);
  console.log(`Health check: http://localhost:${config.port}/health`);
});

export default app;
