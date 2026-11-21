const helmet = require("helmet");
const cors = require("cors");
const mongoSanitize = require("express-mongo-sanitize");
const hpp = require("hpp");

const toOrigin = value => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
};

const getAllowedOrigins = () => [
  process.env.FRONTEND_URL,
  ...(process.env.FRONTEND_URLS || "").split(","),
  process.env.GOOGLE_FRONTEND_REDIRECT_URI
].map(value => toOrigin(value?.trim())).filter(Boolean)
  .filter((origin, i, list) => list.indexOf(origin) === i);

const securityMiddleware = (app) => {

  // Security Headers
  app.use(helmet());

  // CORS Configuration
  // Only the frontend URL(s) from the environment may call the API from a browser:
  // FRONTEND_URL, FRONTEND_URLS (comma-separated) and GOOGLE_FRONTEND_REDIRECT_URI.
  // Requests with no Origin header (server-to-server, cron, curl, devices) are allowed.
  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.length === 0) {
    console.warn("[CORS] No FRONTEND_URL / FRONTEND_URLS set: browser requests from other sites will be blocked");
  }
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
      credentials: true
    })
  );

  // Prevent NoSQL Injection
  // Rejects any request whose body/query/params contain keys starting with "$"
  // (e.g. {"email":{"$gt":""}}). Uses has() instead of mongoSanitize() because
  // mongoSanitize() reassigns req.query, which crashes every request on Express 5.
  app.use((req, res, next) => {
    const parts = { body: req.body, query: req.query, params: req.params };
    for (const [where, value] of Object.entries(parts)) {
      if (value && mongoSanitize.has(value, true)) {
        return res.status(400).json({
          status: "error",
          statusCode: 400,
          message: `Invalid characters in request ${where}`
        });
      }
    }
    next();
  });

  // Prevent HTTP Parameter Pollution
  app.use(hpp());

};

module.exports = securityMiddleware;
module.exports.getAllowedOrigins = getAllowedOrigins;