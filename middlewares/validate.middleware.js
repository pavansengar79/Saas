// module.exports = (schema) => {
//   return (req, res, next) => {

//     const { error } = schema.validate(req.body);

//     if (error) {
//       return res.status(400).json({
//         success: false,
//         message: error.details[0].message
//       });
//     }

//     next();
//   };
// };


// middlewares/validate.middleware.js
// source = "body" (default) | "query" | "params"

module.exports = (schema, source = "body") => {
  return (req, res, next) => {

    const { error, value } = schema.validate(req[source], {
      abortEarly: true,   // Stop at the first error
      allowUnknown: false // Reject extra fields
    });

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Store the validated values, including defaults, back in the request
    req[source] = value;

    next();
  };
};