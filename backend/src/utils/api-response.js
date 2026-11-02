/**
 * Consistent success envelope:
 * { success: true, message: string, data: any }
 */
export const sendSuccess = (res, { statusCode = 200, message = "OK", data = null } = {}) =>
  res.status(statusCode).json({ success: true, message, data });

/** Express 5 forwards rejected promises to the error handler; this keeps controllers terse. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
