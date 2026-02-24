// ============================================================
// Routes — Fill Ingestion + Query (§2.1)
// ============================================================

import { Router, Request, Response } from 'express';
import { getSupabase } from '../db/supabase';
import { parseTradovateFills } from '../subsystem0/parser';
import { tagSessions } from '../subsystem0/session';
import {
  FillEventV1,
  FillUploadRequest,
  FillUploadResponse,
  IngestRun,
  SessionConfig,
  TruthSummary,
  DEFAULT_CONFIG,
} from '../types';
import { authMiddleware, licenseCheckMiddleware } from '../middleware/auth';
import { uploadRateLimiter } from '../middleware/rateLimit';

const router = Router();

// ============================================================
// POST /api/fills/upload — Ingest pre-parsed fills
// ============================================================

router.post(
  '/upload',
  authMiddleware,
  licenseCheckMiddleware,
  uploadRateLimiter,
  async (req: Request, res: Response) => {
    const startedAt = new Date().toISOString();

    try {
      const { account_ref, fills, source_file } = req.body as FillUploadRequest;

      if (!account_ref || !fills || !Array.isArray(fills)) {
        res.status(400).json({ error: 'Missing account_ref or fills array' });
        return;
      }

      const supabase = getSupabase();

      // Fetch session config for this account
      const { data: configData } = await supabase
        .from('user_configs')
        .select('sessions_utc')
        .eq('account_ref', account_ref)
        .single();

      const sessions: SessionConfig[] = configData?.sessions_utc || [];

      // Tag sessions
      tagSessions(fills, sessions);

      // Upsert fills (idempotent by event_id)
      let fillsNew = 0;
      let fillsDuplicate = 0;
      let fillsRejected = 0;

      // Batch upsert in chunks of 100
      const BATCH_SIZE = 100;
      for (let i = 0; i < fills.length; i += BATCH_SIZE) {
        const batch = fills.slice(i, i + BATCH_SIZE);

        const rows = batch.map(f => ({
          event_id: f.event_id,
          source: f.source,
          account_ref: f.account_ref || account_ref,
          timestamp_utc: f.timestamp_utc,
          instrument_root: f.instrument_root,
          contract: f.contract,
          side: f.side,
          qty: f.qty,
          price: f.price,
          commission: f.commission,
          off_session: f.off_session,
        }));

        const { data, error } = await supabase
          .from('fills_canonical')
          .upsert(rows, { onConflict: 'event_id', ignoreDuplicates: true })
          .select('event_id');

        if (error) {
          fillsRejected += batch.length;
        } else {
          fillsNew += data?.length || 0;
          fillsDuplicate += batch.length - (data?.length || 0);
        }
      }

      // Record ingest run
      const ingestRun: Partial<IngestRun> = {
        account_ref,
        source_file: source_file || 'upload',
        fills_parsed: fills.length,
        fills_new: fillsNew,
        fills_duplicate: fillsDuplicate,
        fills_rejected: fillsRejected,
        started_at_utc: startedAt,
        completed_at_utc: new Date().toISOString(),
        status: fillsRejected === 0 ? 'success' : fillsNew > 0 ? 'partial' : 'failed',
      };

      const { data: runData } = await supabase
        .from('ingest_runs')
        .insert(ingestRun)
        .select('id')
        .single();

      const response: FillUploadResponse = {
        ingest_run_id: runData?.id || '',
        fills_new: fillsNew,
        fills_duplicate: fillsDuplicate,
        fills_rejected: fillsRejected,
      };

      res.status(201).json(response);
    } catch (err) {
      res.status(500).json({ error: 'Internal server error', detail: String(err) });
    }
  }
);

// ============================================================
// POST /api/fills/upload-csv — Ingest raw Tradovate CSV
// ============================================================

router.post(
  '/upload-csv',
  authMiddleware,
  licenseCheckMiddleware,
  uploadRateLimiter,
  async (req: Request, res: Response) => {
    const startedAt = new Date().toISOString();

    try {
      const { account_ref, csv_text, source_file } = req.body as {
        account_ref: string;
        csv_text: string;
        source_file: string;
      };

      if (!account_ref || !csv_text) {
        res.status(400).json({ error: 'Missing account_ref or csv_text' });
        return;
      }

      // Parse CSV
      const parseResult = parseTradovateFills(csv_text, account_ref);

      const supabase = getSupabase();

      // Fetch session config
      const { data: configData } = await supabase
        .from('user_configs')
        .select('sessions_utc')
        .eq('account_ref', account_ref)
        .single();

      const sessions: SessionConfig[] = configData?.sessions_utc || [];

      // Tag sessions
      tagSessions(parseResult.fills, sessions);

      // Upsert fills
      let fillsNew = 0;
      let fillsDuplicate = 0;

      const BATCH_SIZE = 100;
      for (let i = 0; i < parseResult.fills.length; i += BATCH_SIZE) {
        const batch = parseResult.fills.slice(i, i + BATCH_SIZE);

        const rows = batch.map(f => ({
          event_id: f.event_id,
          source: f.source,
          account_ref: f.account_ref,
          timestamp_utc: f.timestamp_utc,
          instrument_root: f.instrument_root,
          contract: f.contract,
          side: f.side,
          qty: f.qty,
          price: f.price,
          commission: f.commission,
          off_session: f.off_session,
        }));

        const { data, error } = await supabase
          .from('fills_canonical')
          .upsert(rows, { onConflict: 'event_id', ignoreDuplicates: true })
          .select('event_id');

        if (!error) {
          fillsNew += data?.length || 0;
          fillsDuplicate += batch.length - (data?.length || 0);
        }
      }

      // Record ingest run
      const { data: runData } = await supabase
        .from('ingest_runs')
        .insert({
          account_ref,
          source_file: source_file || 'csv-upload',
          fills_parsed: parseResult.fills.length + parseResult.rejected,
          fills_new: fillsNew,
          fills_duplicate: fillsDuplicate,
          fills_rejected: parseResult.rejected,
          started_at_utc: startedAt,
          completed_at_utc: new Date().toISOString(),
          status: parseResult.rejected === 0 ? 'success' : fillsNew > 0 ? 'partial' : 'failed',
          error_message: parseResult.errors.length > 0 ? parseResult.errors.join('; ') : null,
        })
        .select('id')
        .single();

      res.status(201).json({
        ingest_run_id: runData?.id || '',
        fills_parsed: parseResult.fills.length + parseResult.rejected,
        fills_new: fillsNew,
        fills_duplicate: fillsDuplicate,
        fills_rejected: parseResult.rejected,
        parse_errors: parseResult.errors.slice(0, 20), // cap error list
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error', detail: String(err) });
    }
  }
);

// ============================================================
// GET /api/fills — Query fills for an account
// ============================================================

router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { account_ref, limit, offset, from, to } = req.query;

    if (!account_ref) {
      res.status(400).json({ error: 'Missing account_ref query parameter' });
      return;
    }

    const supabase = getSupabase();
    let query = supabase
      .from('fills_canonical')
      .select('*')
      .eq('account_ref', account_ref as string)
      .order('timestamp_utc', { ascending: true });

    if (from) query = query.gte('timestamp_utc', from as string);
    if (to) query = query.lte('timestamp_utc', to as string);
    query = query.range(
      parseInt((offset as string) || '0', 10),
      parseInt((offset as string) || '0', 10) + parseInt((limit as string) || '100', 10) - 1
    );

    const { data, error } = await query;

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ fills: data || [], count: data?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', detail: String(err) });
  }
});

// ============================================================
// GET /api/fills/summary — Truth Summary (Subsystem 0 output)
// ============================================================

router.get('/summary', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { account_ref } = req.query;

    if (!account_ref) {
      res.status(400).json({ error: 'Missing account_ref query parameter' });
      return;
    }

    const supabase = getSupabase();
    const { data: fills, error } = await supabase
      .from('fills_canonical')
      .select('*')
      .eq('account_ref', account_ref as string)
      .order('timestamp_utc', { ascending: true });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    if (!fills || fills.length === 0) {
      const summary: TruthSummary = {
        account_ref: account_ref as string,
        total_fills: 0,
        date_range: null,
        instruments: [],
        contracts: [],
        fills_per_day: {},
        max_qty: 0,
        off_session_pct: 0,
      };
      res.json(summary);
      return;
    }

    const instruments = [...new Set(fills.map(f => f.instrument_root))];
    const contracts = [...new Set(fills.map(f => f.contract))];
    const maxQty = Math.max(...fills.map(f => f.qty));
    const offSessionCount = fills.filter(f => f.off_session).length;

    const fillsPerDay: Record<string, number> = {};
    for (const f of fills) {
      const day = f.timestamp_utc.slice(0, 10);
      fillsPerDay[day] = (fillsPerDay[day] || 0) + 1;
    }

    const summary: TruthSummary = {
      account_ref: account_ref as string,
      total_fills: fills.length,
      date_range: {
        min: fills[0].timestamp_utc,
        max: fills[fills.length - 1].timestamp_utc,
      },
      instruments,
      contracts,
      fills_per_day: fillsPerDay,
      max_qty: maxQty,
      off_session_pct: fills.length > 0 ? offSessionCount / fills.length : 0,
    };

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', detail: String(err) });
  }
});

export default router;
