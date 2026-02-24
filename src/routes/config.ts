// ============================================================
// Routes — User Config Management
// ============================================================

import { Router, Request, Response } from 'express';
import { getSupabase } from '../db/supabase';
import { UserConfig, DEFAULT_CONFIG } from '../types';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// ============================================================
// GET /api/config/:account_ref — Get user config
// ============================================================

router.get('/:account_ref', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { account_ref } = req.params;
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('user_configs')
      .select('*')
      .eq('account_ref', account_ref)
      .single();

    if (error || !data) {
      // Return defaults
      res.json({
        account_ref,
        ...DEFAULT_CONFIG,
      });
      return;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', detail: String(err) });
  }
});

// ============================================================
// PUT /api/config/:account_ref — Update user config
// ============================================================

router.put('/:account_ref', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { account_ref } = req.params;
    const updates = req.body as Partial<UserConfig>;

    // Validate inputs
    if (updates.max_contracts !== undefined && (updates.max_contracts < 1 || updates.max_contracts > 100)) {
      res.status(400).json({ error: 'max_contracts must be between 1 and 100' });
      return;
    }
    if (updates.max_fills_per_day !== undefined && (updates.max_fills_per_day < 1 || updates.max_fills_per_day > 1000)) {
      res.status(400).json({ error: 'max_fills_per_day must be between 1 and 1000' });
      return;
    }
    if (updates.baseline_window_fills !== undefined && (updates.baseline_window_fills < 5 || updates.baseline_window_fills > 100)) {
      res.status(400).json({ error: 'baseline_window_fills must be between 5 and 100' });
      return;
    }
    if (updates.scoring_window_fills !== undefined && (updates.scoring_window_fills < 5 || updates.scoring_window_fills > 200)) {
      res.status(400).json({ error: 'scoring_window_fills must be between 5 and 200' });
      return;
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('user_configs')
      .upsert({
        account_ref,
        ...updates,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'account_ref' })
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', detail: String(err) });
  }
});

export default router;
