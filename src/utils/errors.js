//Every error the client can see is an ApiError. The global error handler turns anything else into an opaque 500 so internal details never leak
 
export class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
    Error.captureStackTrace?.(this, ApiError);
  }
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.field
          ? {
              field: this.field,
            }
          : {}),
      },
    };
  }
}
export const badRequest = (code, message, field) => new ApiError(400, code, message, field);
export const unauthorized = (message = 'You are not signed in.', code = 'UNAUTHORIZED') =>
  new ApiError(401, code, message);
export const forbidden = (message = 'You do not have access to this resource.') =>
  new ApiError(403, 'FORBIDDEN', message);
export const notFound = (code, message) => new ApiError(404, code, message);
export const conflict = (code, message, field) => new ApiError(409, code, message, field);
export const tooManyRequests = (message) => new ApiError(429, 'TOO_MANY_REQUESTS', message);
