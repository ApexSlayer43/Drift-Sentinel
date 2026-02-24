// ============================================================
// Routes — Health Check
// ============================================================

import { Router, Request, Response } from 'express';
import { getSupabase } from '../db/supabase';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from('fills_canonical').select('event_id').limit(1);

    if (error) {
      res.status(503).json({
        status: 'unhealthy',
        database: 'error',
        error: error.message,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'unreachable',
      error: String(err),
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
