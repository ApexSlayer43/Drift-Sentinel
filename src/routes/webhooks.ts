// ============================================================
// Routes — TradingView Webhook Receiver (§6)
// ============================================================

import { Router, Request, Response } from 'express';
import { getSupabase } from '../db/supabase';
import { webhookRateLimiter } from '../middleware/rateLimit';

const router = Router();

interface WebhookPayload {
  ds_version: string;
  user_license_id: string;
  event_type: string;
  symbol: string;
  timestamp_utc: string;
  // Optional fields
  setup_name?: string;
  intended_direction?: string;
  planned_rr?: number;
  intended_stop_ticks?: number;
  contract_mode?: string;
}

const VALID_EVENT_TYPES = ['SETUP_FIRED', 'CONTRACT_MODE'];

// ============================================================
// POST /api/webhooks/tradingview — Receive TradingView alerts
// ============================================================

router.post(
  '/tradingview',
  webhookRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const payload = req.body as WebhookPayload;

      // Validate required fields
      if (!payload.ds_version || !payload.user_license_id || !payload.event_type ||
          !payload.symbol || !payload.timestamp_utc) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
      }

      // Validate event type
      if (!VALID_EVENT_TYPES.includes(payload.event_type)) {
        res.status(400).json({
          error: `Invalid event_type. Must be one of: ${VALID_EVENT_TYPES.join(', ')}`,
        });
        return;
      }

      // Validate license (MVP: just check non-empty)
      // TODO: Validate against licenses table
      if (!payload.user_license_id) {
        res.status(401).json({ error: 'Invalid license' });
        return;
      }

      const supabase = getSupabase();

      // Store webhook event
      const { error } = await supabase.from('webhook_events').insert({
        user_license_id: payload.user_license_id,
        event_type: payload.event_type,
        symbol: payload.symbol,
        timestamp_utc: payload.timestamp_utc,
        payload: payload,
      });

      if (error) {
        res.status(500).json({ error: 'Failed to store webhook event' });
        return;
      }

      // In MVP, webhooks are context markers only — no drift scoring impact
      res.status(200).json({
        status: 'received',
        event_type: payload.event_type,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error', detail: String(err) });
    }
  }
);

// ============================================================
// GET /api/webhooks/status — Webhook pipe status
// ============================================================

router.get('/status', async (req: Request, res: Response) => {
  try {
    const { user_license_id } = req.query;

    if (!user_license_id) {
      res.status(400).json({ error: 'Missing user_license_id' });
      return;
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('webhook_events')
      .select('created_at, event_type')
      .eq('user_license_id', user_license_id as string)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      res.json({
        status: 'no_events',
        last_received: null,
      });
      return;
    }

    res.json({
      status: 'active',
      last_received: data.created_at,
      last_event_type: data.event_type,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', detail: String(err) });
  }
});

export default router;
