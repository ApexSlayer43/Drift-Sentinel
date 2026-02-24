// ============================================================
// Routes — Drift Engine Evaluation + Query (§3)
// ============================================================

import { Router, Request, Response } from 'express';
import { getSupabase } from '../db/supabase';
import {
  FillEventV1,
  UserConfig,
  DriftScore,
  OnsetMap,
  DEFAULT_CONFIG,
} from '../types';
import { evaluateWithOnset, defaultOnsetMap } from '../engine/drift';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// ============================================================
// POST /api/drift/evaluate — Run drift engine for an account
// ============================================================

router.post('/evaluate', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { account_ref, config: configOverrides } = req.body as {
      account_ref: string;
      config?: Partial<UserConfig>;
    };

    if (!account_ref) {
      res.status(400).json({ error: 'Missing account_ref' });
      return;
    }

    const supabase = getSupabase();

    // Fetch user config (merge defaults ← stored ← request overrides)
    const { data: storedConfig } = await supabase
      .from('user_configs')
      .select('*')
      .eq('account_ref', account_ref)
      .single();

    const config: UserConfig = {
      ...DEFAULT_CONFIG,
      ...(storedConfig ? {
        max_contracts: storedConfig.max_contracts,
        max_fills_per_day: storedConfig.max_fills_per_day,
        baseline_window_fills: storedConfig.baseline_window_fills,
        scoring_window_fills: storedConfig.scoring_window_fills,
        sessions_utc: storedConfig.sessions_utc || [],
      } : {}),
      ...configOverrides,
    };

    // Fetch fills ordered by timestamp (most recent last)
    const totalNeeded = config.scoring_window_fills + config.baseline_window_fills;
    const { data: fills, error: fillsError } = await supabase
      .from('fills_canonical')
      .select('*')
      .eq('account_ref', account_ref)
      .order('timestamp_utc', { ascending: true })
      .limit(totalNeeded);

    if (fillsError) {
      res.status(500).json({ error: fillsError.message });
      return;
    }

    // Actually we need the LAST N fills, so fetch descending then reverse
    const { data: recentFills, error: recentError } = await supabase
      .from('fills_canonical')
      .select('*')
      .eq('account_ref', account_ref)
      .order('timestamp_utc', { ascending: false })
      .limit(totalNeeded);

    if (recentError) {
      res.status(500).json({ error: recentError.message });
      return;
    }

    if (!recentFills || recentFills.length === 0) {
      res.json({
        account_ref,
        drift_index: 0,
        drift_state: 'STABLE',
        total_points: 0,
        drivers: [],
        violations: [],
        scoring_window_size: 0,
        baseline_status: 'building',
        evaluated_at_utc: new Date().toISOString(),
      });
      return;
    }

    // Reverse to chronological order
    const allFills: FillEventV1[] = recentFills.reverse().map(f => ({
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

    // Split into baseline + scoring windows
    const scoringStart = Math.max(0, allFills.length - config.scoring_window_fills);
    const scoringWindow = allFills.slice(scoringStart);
    const baselineEnd = scoringStart;
    const baselineStart = Math.max(0, baselineEnd - config.baseline_window_fills);
    const baselineWindow = allFills.slice(baselineStart, baselineEnd);

    // Fetch current onset state
    const { data: onsetRows } = await supabase
      .from('onset_state')
      .select('*')
      .eq('account_ref', account_ref);

    let currentOnset: OnsetMap = defaultOnsetMap();
    if (onsetRows) {
      for (const row of onsetRows) {
        if (row.mode in currentOnset) {
          const mode = row.mode as keyof OnsetMap;
          if (row.status === 'ACTIVE' && row.onset_utc) {
            currentOnset[mode] = { status: 'ACTIVE', onset_utc: row.onset_utc };
          } else {
            currentOnset[mode] = { status: 'INACTIVE' };
          }
        }
      }
    }

    // Run drift engine
    const { output, updatedOnset, drivers } = evaluateWithOnset(
      {
        scoring_window: scoringWindow,
        baseline_window: baselineWindow,
        config,
        account_ref,
      },
      currentOnset
    );

    // Persist violations (upsert by violation_id)
    if (output.violations.length > 0) {
      const violationRows = output.violations.map(v => ({
        violation_id: v.violation_id,
        account_ref: v.account_ref,
        rule_id: v.rule_id,
        mode: v.mode,
        mode_instance_id: v.mode_instance_id,
        severity: v.severity,
        points: v.points,
        window_start_utc: v.window_start_utc,
        window_end_utc: v.window_end_utc,
        evidence_event_ids: v.evidence_event_ids,
        first_seen_utc: v.first_seen_utc,
        created_at_utc: v.created_at_utc,
      }));

      await supabase
        .from('violations')
        .upsert(violationRows, { onConflict: 'violation_id' });
    }

    // Persist onset state
    const ALL_MODES = ['OVERSIZE', 'OFF_SESSION', 'FREQUENCY', 'BASELINE_SHIFT'] as const;
    for (const mode of ALL_MODES) {
      const state = updatedOnset[mode];
      await supabase
        .from('onset_state')
        .upsert({
          account_ref,
          mode,
          status: state.status,
          onset_utc: state.status === 'ACTIVE' ? state.onset_utc : null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'account_ref,mode' });
    }

    // Persist drift score snapshot
    const evaluatedAt = new Date().toISOString();
    await supabase.from('drift_scores').insert({
      account_ref,
      drift_index: output.drift_index,
      drift_state: output.drift_state,
      total_points: output.total_points,
      drivers,
      violation_ids: output.violations.map(v => v.violation_id),
      scoring_window_size: scoringWindow.length,
      baseline_status: output.baseline_status,
      evaluated_at_utc: evaluatedAt,
    });

    // Build response
    const driftScore: DriftScore = {
      account_ref,
      drift_index: output.drift_index,
      drift_state: output.drift_state,
      total_points: output.total_points,
      drivers,
      violations: output.violations,
      scoring_window_size: scoringWindow.length,
      baseline_status: output.baseline_status,
      evaluated_at_utc: evaluatedAt,
    };

    res.json(driftScore);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', detail: String(err) });
  }
});

// ============================================================
// GET /api/drift/latest — Get latest drift score
// ============================================================

router.get('/latest', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { account_ref } = req.query;

    if (!account_ref) {
      res.status(400).json({ error: 'Missing account_ref query parameter' });
      return;
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('drift_scores')
      .select('*')
      .eq('account_ref', account_ref as string)
      .order('evaluated_at_utc', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      res.json({
        account_ref,
        drift_index: 0,
        drift_state: 'STABLE',
        total_points: 0,
        drivers: [],
        violations: [],
        scoring_window_size: 0,
        baseline_status: 'building',
        evaluated_at_utc: null,
      });
      return;
    }

    // Fetch associated violations
    const violationIds = data.violation_ids || [];
    let violations: any[] = [];
    if (violationIds.length > 0) {
      const { data: vData } = await supabase
        .from('violations')
        .select('*')
        .in('violation_id', violationIds);
      violations = vData || [];
    }

    res.json({
      ...data,
      violations,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', detail: String(err) });
  }
});

// ============================================================
// GET /api/drift/history — Drift score history
// ============================================================

router.get('/history', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { account_ref, limit } = req.query;

    if (!account_ref) {
      res.status(400).json({ error: 'Missing account_ref query parameter' });
      return;
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('drift_scores')
      .select('*')
      .eq('account_ref', account_ref as string)
      .order('evaluated_at_utc', { ascending: false })
      .limit(parseInt((limit as string) || '20', 10));

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ scores: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', detail: String(err) });
  }
});

export default router;
