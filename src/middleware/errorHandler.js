import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { ApiError } from '../utils/errors.js';
import { config } from '../config.js';

/**
 * Wraps an async handler so a rejected promise always reaches the error
 * handler. Without this Express 4 swallows async throws and the request hangs.
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** JSON 404 for unknown routes — never an HTML error page. */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No endpoint matches ${req.method} ${req.path}.`,
    },
  });
}

/**
 * The single place any error becomes a response. Unknown errors become an
 * opaque 500: the real error is logged server-side and NEVER sent to the
 * client, so no stack trace, Mongo error or connection string can leak.
 */
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ApiError) {
    res.status(err.status).json(err.toJSON());
    return;
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: first?.message ?? 'Some of the details you entered are not valid.',
        ...(first?.path?.length
          ? {
              field: String(first.path[0]),
            }
          : {}),
      },
    });
    return;
  }

  // A malformed ObjectId is a client mistake, not a server fault.
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({
      error: {
        code: 'INVALID_ID',
        message: 'That identifier is not valid.',
      },
    });
    return;
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const field = Object.keys(err.errors)[0];
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Some of the details you entered are not valid.',
        ...(field
          ? {
              field,
            }
          : {}),
      },
    });
    return;
  }

  // Duplicate key (e.g. a race on a unique email index).
  if (typeof err === 'object' && err !== null && err.code === 11000) {
    res.status(409).json({
      error: {
        code: 'DUPLICATE_KEY',
        message: 'That record already exists.',
      },
    });
    return;
  }

  // Anything else: log the truth, return nothing useful to an attacker.
  console.error('[myslp] Unhandled error:', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred. Please try again.',
      ...(config.isProd
        ? {}
        : {
            debug: err instanceof Error ? err.message : String(err),
          }),
    },
  });
}
