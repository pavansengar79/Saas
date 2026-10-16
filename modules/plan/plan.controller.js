// modules/plan/plan.controller.js

const planService = require("./plan.service");

// ── Public ────────────────────────────────────────────────────

// GET /plans/public
exports.getPublicPlans = async (req, res, next) => {
  try {
    const result = await planService.getPublicPlans(req.user);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// GET /plans/:id/public
exports.getPlanById = async (req, res, next) => {
  try {
    const plan = await planService.getPlanById(req.params.id);
    return res.status(200).json({ success: true, data: plan });
  } catch (error) {
    next(error);
  }
};

// ── Super Admin ───────────────────────────────────────────────

// GET /plans
exports.getAllPlans = async (req, res, next) => {
  try {
    const plans = await planService.getAllPlans();
    return res.status(200).json({ success: true, data: plans });
  } catch (error) {
    next(error);
  }
};

// POST /plans
exports.createPlan = async (req, res, next) => {
  try {
    const plan = await planService.createPlan(req.body, req.user.userId);
    return res.status(201).json({ success: true, data: plan });
  } catch (error) {
    next(error);
  }
};

// PUT /plans/:id
exports.updatePlan = async (req, res, next) => {
  try {
    const plan = await planService.updatePlan(req.params.id, req.body);
    return res.status(200).json({ success: true, data: plan });
  } catch (error) {
    next(error);
  }
};

// DELETE /plans/:id
exports.deletePlan = async (req, res, next) => {
  try {
    const result = await planService.deletePlan(req.params.id);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};
// GET /plans/my-features
// Return the logged-in user's plan features
// The frontend uses these for feature gates and upgrade prompts
exports.getMyFeatures = async (req, res, next) => {
  try {
    const result = await planService.getMyFeatures(req.user);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// GET /plans/my-plan
// Get current subscription with full plan details (modules, features, prices)
// For org_admin/company_admin to view their current plan
exports.getMyPlan = async (req, res, next) => {
  try {
    const result = await planService.getMyPlan(req.user);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
