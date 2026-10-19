// modules/plan/models/planQuoteRequest.model.js
// "Request quote" for custom (Enterprise) plans from the pricing page.
"use strict";

const mongoose = require("mongoose");

const planQuoteRequestSchema = new mongoose.Schema({
  plan_id:      { type: mongoose.Schema.Types.ObjectId, ref: "Plan", required: true },
  billingCycle: { type: String, enum: ["monthly", "annual"], default: "monthly" },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  name:         { type: String, default: null },
  email:        { type: String, default: null },
  phone:        { type: String, default: null },
  message:      { type: String, default: null, maxlength: 2000 },
  org_id:       { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null },
  company_id:   { type: mongoose.Schema.Types.ObjectId, ref: "Company", default: null },
  status:       { type: String, enum: ["NEW", "CONTACTED", "CLOSED"], default: "NEW", index: true },
}, { timestamps: true });

module.exports = mongoose.models.PlanQuoteRequest
  || mongoose.model("PlanQuoteRequest", planQuoteRequestSchema);
