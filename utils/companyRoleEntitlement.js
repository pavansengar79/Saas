const AppError = require("./appError");
const Subscription = require("../modules/subscription/models/subscription.Models");
const Module = require("../modules/module/models/module.model");

// Company-level roles require the purchased organisation module, regardless
// of structure_level. Older subscription snapshots may store module IDs.
const assertPlanAllowsCompanyRoles = async (orgId, session = null) => {
  const query = Subscription.findOne({ org_id: orgId, is_active: true })
    .select("plan_snapshot.modules");
  if (session) query.session(session);
  const subscription = await query.lean();

  const planModules = (subscription?.plan_snapshot?.modules || []).map(String);
  if (planModules.includes("organisation")) return;

  if (planModules.length > 0) {
    const orgModuleDoc = await Module.findOne({ slug: "organisation" }).select("_id").lean();
    if (orgModuleDoc && planModules.includes(String(orgModuleDoc._id))) return;
  }

  throw new AppError(
    "Your current plan does not include company management. Please upgrade your plan to add company-level users.",
    403
  );
};

module.exports = { assertPlanAllowsCompanyRoles };