/**
 * Lightweight sliding-window in-memory rate limiter for Express routes.
 * Limits repeated requests per client IP + route within a configurable window.
 */
function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  maxRequests = 15,
  message = "Too many attempts. Please try again later.",
  skipSuccessfulRequests = false,
} = {}) {
  const store = new Map();

  // Periodically prune expired keys to keep memory bounded
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (now > entry.resetAt) {
        store.delete(key);
      }
    }
  }, Math.min(windowMs, 10 * 60 * 1000));

  if (typeof cleanupInterval.unref === "function") {
    cleanupInterval.unref();
  }

  return (req, res, next) => {
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      "unknown";
    const key = `${req.baseUrl}${req.path}:${clientIp}`;
    const now = Date.now();
    let record = store.get(key);

    if (!record || now > record.resetAt) {
      record = { count: 1, resetAt: now + windowMs };
      store.set(key, record);
    } else if (record.count >= maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ message });
    } else {
      record.count += 1;
    }

    if (skipSuccessfulRequests) {
      res.on("finish", () => {
        if (res.statusCode < 400 && record.count > 0) {
          record.count -= 1;
        }
      });
    }

    return next();
  };
}

module.exports = { createRateLimiter };

