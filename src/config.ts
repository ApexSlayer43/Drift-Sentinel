import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

export const config = {
  port: parseInt(process.env.PORT || '8000', 10),
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },
  rateLimit: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 60,
  },
};

export function validateConfig(): void {
  if (!config.supabase.url) {
    throw new Error('SUPABASE_URL is required');
  }
  if (!config.supabase.serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
  }
}
