const helmet = require("helmet");
const cors = require("cors");
const mongoSanitize = require("express-mongo-sanitize");
const hpp = require("hpp");

const securityMiddleware = (app) => {

  // Security Headers
  app.use(helmet());

  // CORS Configuration
  app.use(
    cors({
      origin: "*", // Add the frontend domain later
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
