import mongoose from 'mongoose';
import { RateLimit } from '../models/RateLimit.js';
import { tooManyRequests } from '../utils/errors.js';

//Fixed-window rate limiter, counted in MongoDB.

export function rateLimit(options) {
  return function rateLimiter(req, res, next) {
    const now = new Date();
    const resetAt = new Date(now.getTime() + options.windowMs);

    // Behind a proxy the socket address is the proxy's, so prefer the forwarded client address where there is one.
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim()) ||
      req.ip ||
      'unknown';
    const key = `${ip}:${req.baseUrl}${req.path}`;

    // No database yet (startup, or a dropped connection): allow the request. Failing closed here would lock everyone out of signing in over a problem that has nothing to do with them.
    if (mongoose.connection.readyState !== 1) {
      next();
      return;
    }

    RateLimit.findOneAndUpdate(
      { _id: key },
      [
        {
          // An aggregation-pipeline update so "is the window still live?" and "increment it" happen in the same operation. A live window is incremented; an expired or missing one starts again at 1.
          $set: {
            resetAt: {
              $cond: [{ $gt: ['$resetAt', now] }, '$resetAt', resetAt],
            },
            count: {
              $cond: [{ $gt: ['$resetAt', now] }, { $add: ['$count', 1] }, 1],
            },
          },
        },
      ],
      { upsert: true, returnDocument: 'after' },
    )
      .then((doc) => {
        const count = doc?.count ?? 1;
        const windowEnd = doc?.resetAt ?? resetAt;
        const remaining = Math.max(0, options.max - count);

        res.setHeader('X-RateLimit-Limit', String(options.max));
        res.setHeader('X-RateLimit-Remaining', String(remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(windowEnd.getTime() / 1000)));

        if (count > options.max) {
          const retryAfter = Math.max(1, Math.ceil((windowEnd.getTime() - now.getTime()) / 1000));
          res.setHeader('Retry-After', String(retryAfter));
          next(tooManyRequests(options.message));
          return;
        }
        next();
      })
      .catch((err) => {
        // Same reasoning as above: a limiter that cannot count must not be able to take the API down with it.
        console.error('[myslp] rate limit check failed:', err.message);
        next();
      });
  };
}

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
});

export const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many requests. Please slow down.',
});
