import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

// Lets route handlers be async; errors go to the error middleware instead of crashing.
export const handle =
  (fn: (req: Request, res: Response, next?: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function sendError(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

// Compare secrets in constant time, so response timing does not leak them.
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Last middleware: log the error, answer a generic 500 (or 503 if the database is unreachable).
// Client mistakes found by body parsers (bad JSON 400, too large 413) keep their 4xx: bad input is never a 5xx.
export function errorHandler(err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;
  if (err.status && err.status >= 400 && err.status < 500) return sendError(res, err.status, 'bad request');
  console.error('request failed:', err.message);
  const dbDown = /ECONNREFUSED|topology|server selection|connection/i.test(err.message);
  sendError(res, dbDown ? 503 : 500, dbDown ? 'storage unavailable, retry' : 'internal error');
}
