import express from 'express';
import { webhookRouter } from './routes/webhook.js';
import { graderRouter, requireGraderToken } from './routes/grader.js';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';
import { errorHandler } from './lib/http.js';

// Set to true by index.ts once MongoDB and Redis answer and indexes exist.
export const state = { ready: false };

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // basic browser hardening for every response
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // the check waits for 200 here before sending traffic
  app.get('/healthz', (_req, res) => {
    res.status(state.ready ? 200 : 503).json({ ok: state.ready });
  });

  app.use(webhookRouter); // must come before express.json(): it needs the raw body
  app.use('/__grader', requireGraderToken); // token first, so no token = 401 whatever the body is
  app.use(express.json({ limit: '100kb' }));
  app.use(graderRouter);
  app.use(authRouter);
  app.use(apiRouter);

  app.use(errorHandler);
  return app;
}
