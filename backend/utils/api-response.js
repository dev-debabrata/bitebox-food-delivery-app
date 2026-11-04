export const sendSuccess = (
  res,
  { statusCode = 200, message = "OK", data = null } = {},
) => res.status(statusCode).json({ success: true, message, data });

export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export const respond =
  (load, message, statusCode = 200) =>
  async (req, res) => {
    const data = await load(req);
    sendSuccess(res, {
      statusCode,
      message: typeof message === "function" ? message(req, data) : message,
      data,
    });
  };
