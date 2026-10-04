import { REALTIME_PATH } from '@chatme/contracts/realtime';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { AppError } from '../../lib/errors.js';
import type { RealtimeGateway } from './gateway.js';

export function realtimeRoutes(app: FastifyInstance, deps: { config: Config; gateway: RealtimeGateway }) {
  const { config, gateway } = deps;

  app.get(
    REALTIME_PATH,
    {
      websocket: true,
      // Cross-site WebSocket hijacking: browsers attach cookies to WebSocket handshakes
      // from any origin and CORS does not apply, so cookie-authenticated upgrades must
      // come from an allow-listed origin. Bearer-token clients (native apps) are exempt.
      preValidation: async (req) => {
        if (req.auth?.via === 'cookie' && !config.webOrigins.includes(req.headers.origin ?? '')) {
          throw new AppError('forbidden', 403);
        }
      },
    },
    (socket, req) => {
      void gateway.accept(socket, req.auth ? { userId: req.auth.userId, sessionId: req.auth.sessionId, deviceId: req.auth.deviceId } : null);
    },
  );
}
