import { z } from 'zod';
import { ERROR_CODES } from './constants.js';

export { ERROR_CODES, CSRF_HEADER, type ErrorCode } from './constants.js';


export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    requestId: z.string().optional(),
    fields: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

