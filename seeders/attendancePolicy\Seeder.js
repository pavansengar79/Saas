// seeders/attendancePolicy.Seeder.js
// Creates default attendance policy if none exists
// Ensures employees can punch in/out even before HR creates custom policies

const AttendancePolicy = require("../modules/attendancePolicy/models/attendancePolicy.model");
const Company          = require("../modules/company/models/company.model");

exports.seedDefaultAttendancePolicy = async () => {
  console.log("[ATTENDANCE POLICY SEEDER] Checking for default policies...");

  const companies = await Company.find({ isDeleted: false }).select("_id org_id").lean();

  for (const company of companies) {
    // Check if ANY policy exists for this company
    const existingPolicy = await AttendancePolicy.findOne({
      company_id: company._id,
      status: "active",
      isDeleted: false,
    });

    if (existingPolicy) {
      console.log(`[ATTENDANCE POLICY SEEDER] Γ£ô Company ${company._id} already has active policy: "${existingPolicy.name}"`);
      continue;
    }

    // Create default policy
    console.log(`[ATTENDANCE POLICY SEEDER] Creating default policy for company ${company._id}...`);

    const defaultPolicy = await AttendancePolicy.create({
      org_id: company.org_id,
      company_id: company._id,
      unit_id: null, // Company-level default
      name: "Default Attendance Policy",
      description: "Standard attendance policy with 9-6 shift, 15 min grace period, 8 hours minimum",
      status: "active",
      version: 1,
      shift: {
        name: "General Shift",
        start: "09:00",
        end: "18:00",
        graceMinutes: 15,
        minimumHours: 8,
        halfDayMinHours: 4,
      },
      lateMark: {
        enabled: true,
        countAfterMinutes: 15,
        penalty: {
          type: "leave",
          value: 0.5,
        },
        allowedPerMonth: 2,
        escalationAfter: 3,
      },
      sandwichRule: {
        enabled: false,
        includeHolidays: true,
        includeWeekends: true,
        consecutiveLeaveThreshold: 2,
      },
      overtime: {
        enabled: false,
        compensationType: "comp_off",
        minimumMinutes: 60,
        rateMultiplier: 1.5,
        maxHoursPerDay: 4,
      },
      applicableFor: {}, // Empty = applies to all employees (catch-all)
      createdBy: null,
      updatedBy: null,
    });

    console.log(`[ATTENDANCE POLICY SEEDER] Γ£à Created default policy "${defaultPolicy.name}" for company ${company._id}`);
  }

  console.log("[ATTENDANCE POLICY SEEDER] Γ£ô All companies have attendance policies");
};

// Run if called directly
if (require.main === module) {
  const mongoose = require("mongoose");
  require("dotenv").config();

  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      console.log("≡ƒôª Connected to MongoDB");
      await exports.seedDefaultAttendancePolicy();
      process.exit(0);
    })
    .catch((err) => {
      console.error("Γ¥î MongoDB connection error:", err);
      process.exit(1);
    });
}
