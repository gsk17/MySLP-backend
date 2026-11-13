import { ZodError } from 'zod';
import { badRequest } from '../utils/errors.js';
/**
 * Validates and REPLACES the given request section with the parsed result, so
 * handlers always receive typed, coerced, trusted data.
 */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    try {
      const parsed = schema.parse(req[source]);
      if (source === 'body') {
        req.body = parsed;
      } else {
        // req.query and req.params are getter-only in Express 5; assign fields.
        Object.assign(req[source], parsed);
        req[`validated_${source}`] = parsed;
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const issue = err.issues[0];
        next(
          badRequest(
            'VALIDATION_ERROR',
            issue?.message ?? 'Some of the details you entered are not valid.',
            issue?.path?.length ? String(issue.path[0]) : undefined,
          ),
        );
        return;
      }
      next(err);
    }
  };
}

/** Read the parsed value stashed by `validate` for query/params. */
export function validated(req, source) {
  return req[`validated_${source}`] ?? req[source];
}
