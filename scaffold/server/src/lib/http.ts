import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

// Lets route handlers be async; errors go to the error middleware instead of crashing.
export const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
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
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  console.error('request failed:', err.message);
  if (res.headersSent) return;
  const dbDown = /ECONNREFUSED|topology|server selection|connection/i.test(err.message);
  sendError(res, dbDown ? 503 : 500, dbDown ? 'storage unavailable, retry' : 'internal error');
}
