// middlewares/customerAuthenticate.middleware.js
// Validates the customer JWT (separate from the user JWT)

const jwt      = require("jsonwebtoken");
const Customer = require("../modules/customer/models/customer.model");
const AppError = require("../utils/appError");

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Token required" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== "customer" || !decoded.customerId) {
      return res.status(403).json({ success: false, message: "Customer token required" });
    }

    const customer = await Customer.findOne({
      _id:        decoded.customerId,
      is_deleted: false,
      status:     "Active",
    }).select("-password");

    if (!customer) {
      return res.status(401).json({ success: false, message: "Customer not found" });
    }

    req.customer = customer;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
};