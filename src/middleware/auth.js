import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/User.js';
import { forbidden, unauthorized } from '../utils/errors.js';
export function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  });
}

/**
 * Builds the session payload for a user, stamping the password version into
 * the token.
 *
 * `pv` is the millisecond timestamp of the last password change (0 if never).
 * Comparing it on each request is what lets a stateless JWT be revoked: change
 * the password and every token carrying the old value stops matching.
 *
 * An earlier attempt compared the token's `iat` against passwordChangedAt
 * instead. That silently failed, because `iat` has one-second resolution — a
 * reset in the same second as the token left the old session alive.
 */
export function sessionPayload(user) {
  return {
    sub: String(user._id),
    email: user.email,
    role: user.role,
    pv: user.passwordChangedAt ? user.passwordChangedAt.getTime() : 0,
  };
}

/** Reads and validates the Bearer token. 401 when missing, malformed or expired. */
export function requireAuth(req, _res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(unauthorized('Sign in to continue.', 'MISSING_TOKEN'));
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return next(unauthorized('Sign in to continue.', 'MISSING_TOKEN'));
  }
  try {
    const decoded = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
    });
    req.user = {
      sub: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      pv: decoded.pv ?? 0,
    };
    return next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(unauthorized('Your session has expired. Please sign in again.', 'TOKEN_EXPIRED'));
    }
    return next(unauthorized('Your session is invalid. Please sign in again.', 'INVALID_TOKEN'));
  }
}

/** Layers an admin role check on top of requireAuth. */
/**
 * Rejects a structurally valid token that predates the account's last password
 * change. JWTs are stateless, so a reset cannot revoke them directly — this
 * compares the token's `iat` against `passwordChangedAt` instead.
 *
 * Mounted after requireAuth on the routes that matter. It costs one indexed
 * lookup, which is why it is not folded into requireAuth itself.
 */
export async function rejectStaleSession(req, _res, next) {
  try {
    if (!req.user) return next();

    const user = await User.findById(req.user.sub).select('passwordChangedAt');
    if (!user) {
      return next(unauthorized('Your account could not be found.', 'USER_NOT_FOUND'));
    }

    const current = user.passwordChangedAt ? user.passwordChangedAt.getTime() : 0;
    if ((req.user.pv ?? 0) !== current) {
      return next(
        unauthorized('Your password was changed. Please sign in again.', 'PASSWORD_CHANGED'),
      );
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireAdmin(req, _res, next) {
  if (!req.user) {
    return next(unauthorized());
  }
  if (req.user.role !== 'admin') {
    return next(forbidden('This area is for administrators only.'));
  }
  return next();
}
