const helmet = require("helmet");
const cors = require("cors");
const mongoSanitize = require("express-mongo-sanitize");
const hpp = require("hpp");

const securityMiddleware = (app) => {

  // Security Headers
  app.use(helmet());
//   app.use(mongoSanitize({
//   replaceWith: "_"
// }));

  // CORS Configuration
  app.use(
    cors({
      origin: "*", // Add the frontend domain later
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
      credentials: true
    })
  );

  // Prevent NoSQL Injection
  // app.use(mongoSanitize());

  // Prevent HTTP Parameter Pollution
  app.use(hpp());

};

module.exports = securityMiddleware;
