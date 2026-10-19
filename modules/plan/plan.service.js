// modules/plan/plan.service.js

const AppError     = require("../../utils/appError");
const Plan         = require("./models/plan.model");
const Subscription = require("../subscription/models/subscription.Models");
const OrgModule    = require("../orgModule/models/orgModule.model");
const Module       = require("../module/models/module.model");

// ─────────────────────────────────────────────────────────────
// PUBLIC
// ─────────────────────────────────────────────────────────────

// GET /plans/public
exports.getPublicPlans = async (user) => {
  const plans = await Plan.find({
    status:     "Active",
    is_public:  true,
    is_deleted: false,
  })
    .populate("modules", "name slug description")
    .sort({ price_monthly: 1 });

  let currentPlanId = null;
  let currentSubscription = null;

  // If user is authenticated, get current subscription
  if (user?.orgId) {
    const subscription = await Subscription.findOne({
      org_id: user.orgId,
      is_active: true,
      status: { $in: ["Active", "Trial", "PastDue"] }
    }).lean();

    if (subscription) {
      currentPlanId = subscription.plan_id?.toString();
      currentSubscription = {
        planId: subscription.plan_id,
        planName: subscription.plan_snapshot?.name,
        status: subscription.status,
        billing_cycle: subscription.billing_cycle,
        trial_end: subscription.trial_ends_at,
        next_billing: subscription.ends_at,
        seats_used: subscription.seats_purchased,
        seat_limit: subscription.plan_snapshot?.seat_limit,
        package_type: subscription.plan_snapshot?.package_type,
        starts_at: subscription.starts_at,
        ends_at: subscription.ends_at,
      };
    }
  }

  const formattedPlans = plans.map(plan => {
    const isCurrentPlan = currentPlanId && plan._id.toString() === currentPlanId;
    
    return {
      _id:             plan._id,
      name:            plan.name,
      package_type:    plan.package_type,
      structure_level: plan.structure_level,
      price_monthly:   plan.price_monthly,
      price_annual:    plan.price_annual,
      seat_limit:      plan.seat_limit,
      modules:         plan.modules,
      is_custom:       plan.is_custom,
      is_current_plan: isCurrentPlan,
    };
  });

  return {
    plans: formattedPlans,
    currentSubscription,
  };
};

// GET /plans/:id/public
exports.getPlanById = async (planId) => {
  const plan = await Plan.findOne({
    _id:        planId,
    status:     "Active",
    is_public:  true,
    is_deleted: false,
  }).populate("modules", "name slug description");

  if (!plan) throw new AppError("Plan not found", 404);
  return plan;
};

// ─────────────────────────────────────────────────────────────
// SUPER ADMIN
// ─────────────────────────────────────────────────────────────

// GET /plans
exports.getAllPlans = async () => {
  return await Plan.find({ is_deleted: false })
    .populate("modules", "name slug description")
    .sort({ createdAt: -1 });
};

// POST /plans
exports.createPlan = async (data, userId) => {
  const existing = await Plan.findOne({ name: data.name, is_deleted: false });
  if (existing) throw new AppError("Plan with this name already exists", 409);

  // Validate module IDs exist
  if (data.modules && data.modules.length) {
    const moduleDocs = await Module.find({ _id: { $in: data.modules }, is_active: true });
    if (moduleDocs.length !== data.modules.length) {
      throw new AppError("One or more module IDs are invalid or inactive", 400);
    }
  }

  const plan = await Plan.create({ ...data, created_by: userId });
  return await Plan.findById(plan._id).populate("modules", "name slug description");
};

// PUT /plans/:id
exports.updatePlan = async (planId, data) => {
  const plan = await Plan.findOne({ _id: planId, is_deleted: false })
    .populate("modules", "_id slug");

  if (!plan) throw new AppError("Plan not found", 404);

  const oldModuleIds  = plan.modules.map(m => m._id.toString());
  const newModuleIds  = data.modules ? data.modules.map(id => id.toString()) : oldModuleIds;

  const modulesChanged =
    data.modules &&
    JSON.stringify([...oldModuleIds].sort()) !== JSON.stringify([...newModuleIds].sort());

const featuresChanged = data.features && JSON.stringify(data.features.sort()) !== JSON.stringify((plan.features || []).sort());

if (modulesChanged || featuresChanged) {
    const removedIds = oldModuleIds.filter(id => !newModuleIds.includes(id));
    const addedIds   = newModuleIds.filter(id => !oldModuleIds.includes(id));

    // All orgs on this plan
    const affectedOrgs = await Subscription.find({
      plan_id:   planId,
      is_active: true,
      status:    { $in: ["Active", "Trial"] },
    }).distinct("org_id");

    if (affectedOrgs.length > 0) {

      // Disable removed modules
      if (removedIds.length > 0) {
        await OrgModule.updateMany(
          { org_id: { $in: affectedOrgs }, module_id: { $in: removedIds } },
          { is_active: false, deactivated_at: new Date() }
        );
      }

      // Enable added modules
      if (addedIds.length > 0) {
        const now = new Date();
        for (const orgId of affectedOrgs) {
          for (const moduleId of addedIds) {
            await OrgModule.findOneAndUpdate(
              { org_id: orgId, module_id: moduleId },
              { $setOnInsert: { org_id: orgId, module_id: moduleId, is_active: true, activated_at: now } },
              { upsert: true }
            );
          }
        }
      }

      // Update plan_snapshot — store slugs (permission filter uses slugs)
      const newModuleDocs = await Module.find({ _id: { $in: newModuleIds } }).select("slug");
      const newSlugs      = newModuleDocs.map(m => m.slug);

     await Subscription.updateMany(
    { plan_id: planId, is_active: true, status: { $in: ["Active", "Trial"] } },
    {
      $set: {
        "plan_snapshot.modules":         newSlugs,
        "plan_snapshot.features":        data.features         || plan.features || [],
        "plan_snapshot.structure_level": data.structure_level || plan.structure_level,
        "plan_snapshot.name":            data.name            || plan.name,
        "plan_snapshot.price_monthly":   data.price_monthly   ?? plan.price_monthly,
        "plan_snapshot.price_annual":    data.price_annual    ?? plan.price_annual,
        "plan_snapshot.seat_limit":      data.seat_limit      ?? plan.seat_limit,
      },
    }
);

console.log(`✅ plan_snapshot updated for ${affectedOrgs.length} orgs`);

      console.log(`✅ plan_snapshot updated for ${affectedOrgs.length} orgs`);
    }
  }

  data.version = (plan.version || 1) + 1;
  Object.assign(plan, data);
  await plan.save();

  return await Plan.findById(plan._id).populate("modules", "name slug description");
};

// DELETE /plans/:id
exports.deletePlan = async (planId) => {
  const plan = await Plan.findOne({ _id: planId, is_deleted: false });
  if (!plan) throw new AppError("Plan not found", 404);

  const activeSubs = await Subscription.countDocuments({
    plan_id:   planId,
    is_active: true,
    status:    { $in: ["Active", "Trial"] },
  });

  if (activeSubs > 0) {
    throw new AppError(
      `Cannot delete — ${activeSubs} active subscription(s) use this plan.`,
      400
    );
  }

  plan.status     = "Deprecated";
  plan.is_deleted = true;
  await plan.save();

  return { message: "Plan deprecated successfully" };
};
// GET /plans/my-plan
// Get current subscription with full plan details
exports.getMyPlan = async (user) => {
  if (!user?.orgId) {
    throw new AppError("Organization ID not found", 400);
  }

  const subscription = await Subscription.findOne({
    org_id: user.orgId,
    is_active: true,
    status: { $in: ["Active", "Trial", "PastDue"] }
  })
    .populate("plan_id", "name package_type structure_level price_monthly price_annual seat_limit")
    .lean();

  if (!subscription) {
    throw new AppError("No active subscription found", 404);
  }

  // Get module details for the modules in plan_snapshot
  const Module = require("../module/models/module.model");
  const moduleIds = subscription.plan_snapshot?.modules || [];
  
  let modules = [];
  if (moduleIds.length > 0) {
    modules = await Module.find({ _id: { $in: moduleIds } })
      .select("name slug description")
      .lean();
  }

  return {
    subscription: {
      _id: subscription._id,
      status: subscription.status,
      billing_cycle: subscription.billing_cycle,
      starts_at: subscription.starts_at,
      ends_at: subscription.ends_at,
      trial_end: subscription.trial_ends_at,
      grace_ends_at: subscription.grace_ends_at,
      seats_purchased: subscription.seats_purchased,
    },
    plan: {
      _id: subscription.plan_id?._id,
      name: subscription.plan_snapshot?.name || subscription.plan_id?.name,
      package_type: subscription.plan_snapshot?.package_type,
      structure_level: subscription.plan_snapshot?.structure_level,
      price_monthly: subscription.plan_snapshot?.price_monthly,
      price_annual: subscription.plan_snapshot?.price_annual,
      seat_limit: subscription.plan_snapshot?.seat_limit,
      modules: modules,
      features: subscription.plan_snapshot?.features || [],
    },
  };
};

// ─────────────────────────────────────────────────────────────
// GET MY FEATURES
// GET /plans/my-features
//
// Return features[] from the current user's active subscription
// The frontend should use this to decide:
//   - Which buttons/screens to show as locked
//   - When to show an upgrade prompt
//
// Response:
// {
//   plan: { name, package_type },
//   features: ["shift_roster", "bulk_import_export", ...],
//   featureMap: { shift_roster: true, saml_sso: false, ... }
// }
//
// featureMap contains all known features with true/false values
// The frontend should call this once and cache it locally
// ─────────────────────────────────────────────────────────────

// exports.getMyFeatures = async (user) => {
//   // ── Step 1: Collect the union of features from all active plans (fully dynamic) ──
//   // A new feature added to any plan will appear here automatically
//   // No hardcoded list — resolved from the database
//   const allPlans = await Plan.find({
//     status:     "Active",
//     is_deleted: false,
//   }).select("features").lean();

//   const ALL_FEATURE_KEYS = [
//     ...new Set(allPlans.flatMap((p) => p.features || [])),
//   ];

//   // ── Step 2: SUPER_ADMIN — receives all features ───────────────
//   if (user.role === "SUPER_ADMIN" || user.roleSlug === "super_admin") {
//     const featureMap = {};
//     ALL_FEATURE_KEYS.forEach((k) => { featureMap[k] = true; });
//     return {
//       plan:       { name: "Super Admin", package_type: "enterprise" },
//       features:   ALL_FEATURE_KEYS,
//       featureMap,
//     };
//   }

//   // ── Step 3: Active subscription fetch ────────────────────────
//   const subscription = await Subscription.findOne({
//     org_id:    user.orgId,
//     is_active: true,
//   })
//     .select("plan_snapshot.features plan_snapshot.name plan_snapshot.package_type status")
//     .lean();

//   const features    = subscription?.plan_snapshot?.features    || [];
//   const planName    = subscription?.plan_snapshot?.name        || "Trial";
//   const packageType = subscription?.plan_snapshot?.package_type || "professionals";

//   // ── Step 4: Build featureMap ──────────────────────────────────
//   // All known keys (from DB) → true if included in the user's plan
//   // If Super Admin adds a new feature to any plan →
//   // it appears in this map automatically, with no code change needed
//   const featureMap = {};
//   ALL_FEATURE_KEYS.forEach((key) => {
//     featureMap[key] = features.includes(key);
//   });

//   return {
//     plan: {
//       name:         planName,
//       package_type: packageType,
//       status:       subscription?.status || "Trial",
//     },
//     features,    // array of enabled feature keys for this user
//     featureMap,  // { shift_roster: true, saml_sso: false, ... }
//     // allFeatureKeys included so frontend knows complete universe
//     allFeatureKeys: ALL_FEATURE_KEYS,
//   };
// };


exports.getMyFeatures = async (user) => {
  // ── Step 1: Collect the union of features from all active plans (fully dynamic) ──
  // A new feature added to any plan will appear here automatically
  // No hardcoded list — resolved from the database
  const allPlans = await Plan.find({
    status:     "Active",
    is_deleted: false,
  }).select("features moduleSlugs").lean();

  const ALL_FEATURE_KEYS = [
    ...new Set(allPlans.flatMap((p) => p.features || [])),
  ];

  // ── ALL_MODULE_KEYS — same pattern as features, but for base modules ──
  // (employee/attendance/leave/payroll/shift/etc.) so the frontend can
  // build its sidebar dynamically instead of hardcoding which nav items
  // exist per role.
  const ALL_MODULE_KEYS = [
    ...new Set(allPlans.flatMap((p) => p.moduleSlugs || [])),
  ];

  // ── Step 2: SUPER_ADMIN — receives all features ───────────────
  if (user.role === "SUPER_ADMIN" || user.roleSlug === "super_admin") {
    const featureMap = {};
    ALL_FEATURE_KEYS.forEach((k) => { featureMap[k] = true; });

    const moduleMap = {};
    ALL_MODULE_KEYS.forEach((k) => { moduleMap[k] = true; });

    return {
      plan:       { name: "Super Admin", package_type: "enterprise" },
      features:   ALL_FEATURE_KEYS,
      featureMap,
      modules:    ALL_MODULE_KEYS,
      moduleMap,
    };
  }

  // ── Step 3: Active subscription fetch ────────────────────────
  const subscription = await Subscription.findOne({
    org_id:    user.orgId,
    is_active: true,
  })
    .select("plan_snapshot.features plan_snapshot.modules plan_snapshot.name plan_snapshot.package_type status")
    .lean();

  const features    = subscription?.plan_snapshot?.features    || [];
  const modules      = subscription?.plan_snapshot?.modules     || [];
  const planName    = subscription?.plan_snapshot?.name        || "Trial";
  const packageType = subscription?.plan_snapshot?.package_type || "professionals";

  // ── Step 4: Build featureMap / moduleMap ───────────────────────
  // All known keys (from DB) → true if included in the user's plan
  // If Super Admin adds a new feature/module to any plan →
  // it appears in these maps automatically, with no code change needed
  const featureMap = {};
  ALL_FEATURE_KEYS.forEach((key) => {
    featureMap[key] = features.includes(key);
  });

  const moduleMap = {};
  ALL_MODULE_KEYS.forEach((key) => {
    moduleMap[key] = modules.includes(key);
  });

  return {
    plan: {
      name:         planName,
      package_type: packageType,
      status:       subscription?.status || "Trial",
    },
    features,    // array of enabled feature keys for this user
    featureMap,  // { shift_roster: true, saml_sso: false, ... }
    modules,     // array of enabled BASE modules — ["employee","attendance",...]
    moduleMap,   // { attendance: true, payroll: false, ... } — for building sidebar/nav dynamically
    // allFeatureKeys/allModuleKeys included so frontend knows complete universe
    allFeatureKeys: ALL_FEATURE_KEYS,
    allModuleKeys:  ALL_MODULE_KEYS,
  };
};
// ─────────────────────────────────────────────────────────────
// CONTACT SALES — "Request quote" for a custom (Enterprise) plan
// ─────────────────────────────────────────────────────────────
exports.contactSales = async (body = {}, user = {}) => {
  const mongoose = require("mongoose");
  const PlanQuoteRequest = require("./models/planQuoteRequest.model");
  const { sendEmail } = require("../../utils/email/email");

  const { planId, billingCycle = "monthly" } = body;
  if (!planId || !mongoose.isValidObjectId(planId)) throw new AppError("planId is required", 400);
  if (!["monthly", "annual"].includes(billingCycle)) throw new AppError("billingCycle must be monthly or annual", 400);
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 2000) : null;
  const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 30) : null;

  const plan = await Plan.findOne({ _id: planId, is_deleted: false }).select("name").lean();
  if (!plan) throw new AppError("Plan not found", 404);

  let account = null;
  if (user.userId) {
    const User = require("../auth/models/user.model");
    account = await User.findById(user.userId).select("name email").lean();
  }

  // One open request per user and plan is enough
  const existing = user.userId
    ? await PlanQuoteRequest.findOne({ userId: user.userId, plan_id: plan._id, status: "NEW" })
    : null;
  if (existing) return existing;

  const request = await PlanQuoteRequest.create({
    plan_id: plan._id,
    billingCycle,
    userId: user.userId || null,
    name: account?.name || user.name || null,
    email: account?.email || user.email || null,
    phone,
    message,
    org_id: user.orgId || null,
    company_id: user.companyId || null,
  });

  const salesEmail = process.env.SALES_EMAIL || process.env.SUPER_ADMIN_EMAIL;
  if (salesEmail) {
    sendEmail({
      to: salesEmail,
      subject: `Quote request: ${plan.name} (${billingCycle})`,
      html: `<p><strong>${request.name || "A customer"}</strong> (${request.email || "no email"}) requested a quote for
        <strong>${plan.name}</strong>, billed ${billingCycle}.</p>
        ${phone ? `<p>Phone: ${phone}</p>` : ""}${message ? `<p>Message: ${message}</p>` : ""}
        <p>Request ID: ${request._id}</p>`,
    }).catch(error => console.error("[contactSales] email failed:", error.message));
  }
  return request;
};

exports.getQuoteRequests = async (query = {}) => {
  const PlanQuoteRequest = require("./models/planQuoteRequest.model");
  const filter = {};
  if (["NEW", "CONTACTED", "CLOSED"].includes(query.status)) filter.status = query.status;
  return PlanQuoteRequest.find(filter)
    .populate("plan_id", "name")
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(query.limit) || 50, 200))
    .lean();
};
