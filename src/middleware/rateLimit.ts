// ============================================================
// Middleware — Rate Limiting
// ============================================================

import rateLimit from 'express-rate-limit';

/**
 * General API rate limiter.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

/**
 * Webhook-specific rate limiter (stricter).
 */
export const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 webhook events per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Webhook rate limit exceeded' },
});

/**
 * Upload rate limiter (generous but bounded).
 */
export const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 10 uploads per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Upload rate limit exceeded' },
});
