// const mongoose = require("mongoose");

// const tenantSchema = new mongoose.Schema({

//   tenantCode: {
//     type: String,
//     required: true,
//     unique: true
//   },

//   companyName: {
//     type: String,
//     required: true,
//     trim: true
//   },

//   companyEmail: {
//     type: String,
//     required: true,
//     lowercase: true,
//     trim: true
//   },

//   companyPhone: {
//     type: String
//   },

//   plan: {
//     type: String,
//     enum: ["FREE", "BASIC", "PRO", "ENTERPRISE"],
//     default: "FREE"
//   },

//   status: {
//     type: String,
//     enum: ["ACTIVE", "SUSPENDED", "INACTIVE"],
//     default: "ACTIVE"
//   },

//   subdomain: {
//     type: String,
//     unique: true,
//     sparse: true
//   },

//   address: {
//     country: String,
//     state: String,
//     city: String,
//     pincode: String
//   },

//   onboardingDate: {
//     type: Date,
//     default: Date.now
//   },

//   createdBy: {
//     type: String
//   },
//   isDeleted:{
//     type: Boolean,
//     default: false
//   }

// }, { timestamps: true });

// module.exports = mongoose.model("Tenant", tenantSchema);
const mongoose = require("mongoose");

const tenantSchema = new mongoose.Schema({

  // ─── Basic Info ───────────────────────────────
  tenantCode: {
    type: String,
    required: true,
    unique: true
  },

  companyName: {
    type: String,
    required: false,
    trim: true
  },

  companyEmail: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },

  companyPhone: {
    type: String,
    required: true
  },

  // ─── Plan & Trial ─────────────────────────────
  plan: {
    type: String,
    enum: ["TRIAL", "BASIC", "PRO", "ENTERPRISE"],
    default: "TRIAL"
  },

  trialEndsAt: {
    type: Date,
    default: () => new Date(+new Date() + 14 * 24 * 60 * 60 * 1000)
  },

  isTrialExpired: {
    type: Boolean,
    default: false
  },

  // ─── Onboarding ───────────────────────────────
  onboardingStep: {
    type: Number,
    default: 1    // 1=basic done, 2=company details done, 3=complete
  },

  isOnboardingComplete: {
    type: Boolean,
    default: false
  },

  // ─── Company Details (Step 2) ─────────────────
  companySize: {
    type: String,
    enum: ["1-10", "11-50", "51-200", "201-500", "500+"]
  },

  workingHours: {
  startTime: {
    type: String,
    default: "09:00"
  },
  endTime: {
    type: String,
    default: "18:00"
  },
  workingDays: {
    type: [String],
    enum: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
    default: ["MON", "TUE", "WED", "THU", "FRI"]
  },
  saturdayType: {           // ← inside workingHours
    type: String,
    enum: ["NONE", "FULL", "ALTERNATE_ODD", "ALTERNATE_EVEN"],
    default: "NONE"
  }
},

yearType: {
  type:    String,
  enum:    ["CALENDAR", "FINANCIAL"],
  default: "CALENDAR",
},

  leavePolicy: {
    annualLeave:  { type: Number, default: 12 },
    sickLeave:    { type: Number, default: 6 },
    casualLeave:  { type: Number, default: 6 }
  },

  paySchedule: {
    type: String,
    enum: ["WEEKLY", "BIWEEKLY", "MONTHLY"],
    default: "MONTHLY"
  },

  address: {
    country: { type: String },
    state:   { type: String },
    city:    { type: String },
    pincode: { type: String }
  },

  subdomain: {
    type: String,
    unique: true,
    sparse: true
  },

  // ─── Auth ─────────────────────────────────────
  authProvider: {
    type: String,
    enum: ["LOCAL", "GOOGLE"],
    default: "LOCAL"
  },

  // ─── Status ───────────────────────────────────
  status: {
    type: String,
    enum: ["ACTIVE", "SUSPENDED", "INACTIVE"],
    default: "ACTIVE"
  },

  isDeleted: {
    type: Boolean,
    default: false
  },

  // ─── Meta ─────────────────────────────────────
  onboardingDate: {
    type: Date,
    default: Date.now
  },

  createdBy: {
    type: String
  }

}, { timestamps: true });

module.exports = mongoose.model("Tenant", tenantSchema);
