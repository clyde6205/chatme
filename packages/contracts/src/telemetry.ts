import { z } from 'zod';

/** Client performance samples (web-vitals and app timings). Numbers only; no PII. */
export const perfMetricNameSchema = z.enum([
  'LCP', 'FCP', 'INP', 'CLS', 'TTFB',
  'app_shell_render', 'cold_start', 'warm_start',
]);

export const perfReportSchema = z.object({
  platform: z.enum(['web', 'android', 'ios', 'desktop']),
  deviceClass: z.enum(['low', 'normal', 'high']),
  connection: z.enum(['offline', 'slow-2g', '2g', '3g', '4g', 'unknown']),
  appVersion: z.string().max(32),
  samples: z
    .array(z.object({ name: perfMetricNameSchema, value: z.number().finite().nonnegative().max(600_000) }))
    .min(1)
    .max(20),
});
export type PerfReport = z.infer<typeof perfReportSchema>;
