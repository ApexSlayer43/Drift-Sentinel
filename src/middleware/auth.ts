// ============================================================
// Middleware — License/Device Token Auth (Stubbed for MVP)
// ============================================================

import { Request, Response, NextFunction } from 'express';

/**
 * MVP auth middleware.
 * For now, accepts any request with a valid-looking device token header.
 * In production: validate against licenses table in Supabase.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers['x-device-token'] || req.headers['authorization'];

  if (!token) {
    res.status(401).json({ error: 'Missing authentication token' });
    return;
  }

  // MVP: accept any non-empty token
  // TODO: Validate against licenses table, check status != expired/suspended
  (req as any).deviceToken = token;
  next();
}

/**
 * License check middleware (stubbed).
 * In production: verify license is active, check rate limits per plan.
 */
export function licenseCheckMiddleware(req: Request, res: Response, next: NextFunction): void {
  // MVP: pass-through
  // TODO: Query licenses table, check:
  //   - status IN ('trial', 'active')
  //   - fills_per_month not exceeded
  //   - max_accounts not exceeded
  next();
}
