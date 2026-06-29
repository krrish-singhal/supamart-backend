// Wrap async route handlers so thrown errors hit the error middleware.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, req, res, next) {
  const status = err.statusCode || 500;
  const payload = { error: err.message || "Internal Server Error" };
  if (err.code) payload.code = err.code;
  if (status >= 500) console.error(err);
  res.status(status).json(payload);
}

function notFound(req, res) {
  res.status(404).json({ error: "Route not found" });
}

module.exports = { asyncHandler, errorHandler, notFound };
