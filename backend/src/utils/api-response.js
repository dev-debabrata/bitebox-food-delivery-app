/**
 * Consistent success envelope:
 * { success: true, message: string, data: any }
 */
export const sendSuccess = (res, { statusCode = 200, message = "OK", data = null } = {}) =>
  res.status(statusCode).json({ success: true, message, data });

/** Express 5 forwards rejected promises to the error handler; this keeps controllers terse. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * A controller that just returns a service result:
 *   export const getThing = respond((req) => service.get(req.params.id), "Optional message");
 * `message` may also be a function of (req, data). Mongoose documents in `data` are
 * serialised through their toJSON transforms by res.json, so return them as they are.
 */
export const respond = (load, message, statusCode = 200) => async (req, res) => {
  const data = await load(req);
  sendSuccess(res, { statusCode, message: typeof message === "function" ? message(req, data) : message, data });
};
