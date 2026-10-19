// modules/holiday/models/holiday.models.js
// UPDATED — tenantId → org_id + company_id
// Holidays are company-level

const mongoose = require("mongoose");

const holidayCalendarSchema = new mongoose.Schema(
  {
    // ── Scope Fields ──────────────────────────────────────
    org_id: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Organization",
      required: [true, "org_id is required"],
      index:    true,
    },

    company_id: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: [true, "company_id is required"],
      index:    true,
    },

    unit_id: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Unit",
      required: false, // Optional: null = org/company level, ObjectId = unit level
      index:    true,
      default:  null,
    },

    // ── Holiday Info ──────────────────────────────────────
    name: {
      type:      String,
      required:  [true, "Holiday name is required"],
      trim:      true,
      minlength: [3, "Name must be at least 3 characters"],
      maxlength: [100, "Name cannot exceed 100 characters"],
    },

    date: {
      type:     Date,
      required: [true, "Date is required"],
    },

    type: {
      type: String,
      enum: {
        // The app offers Regional and Religious holidays too — they were rejected before
        values:  ["NATIONAL", "COMPANY", "OPTIONAL", "REGIONAL", "RELIGIOUS"],
        message: "Type must be NATIONAL, COMPANY, REGIONAL, RELIGIOUS or OPTIONAL",
      },
      required: [true, "Holiday type is required"],
    },

    // ── Year Info ─────────────────────────────────────────
    yearType: {
      type:    String,
      enum:    ["CALENDAR", "FINANCIAL"],
      default: "CALENDAR",
    },

    year: {
      type:     Number,
      required: true,
      index:    true,
    },

    // ── Status ────────────────────────────────────────────
    isRecurring: { type: Boolean, default: false },
    isActive:    { type: Boolean, default: true, index: true },
    isDeleted:   { type: Boolean, default: false, index: true },
    isSystem: { type: Boolean, default: false },


    createdBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "User",
      default: null,
    },

    updatedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "User",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Indexes ───────────────────────────────────────────────
holidayCalendarSchema.index({ company_id: 1, year: 1, isActive: 1 });

// Unique: same company/unit + same date
holidayCalendarSchema.index(
  { company_id: 1, unit_id: 1, date: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  }
);

holidayCalendarSchema.index({ company_id: 1, type: 1 });

// ── Pre Hook — Soft delete filter ─────────────────────────
holidayCalendarSchema.pre(/^find/, function () {
  this.where({ isDeleted: false });
});

// ── Virtual — Human readable date ─────────────────────────
holidayCalendarSchema.virtual("formattedDate").get(function () {
  return this.date.toLocaleDateString("en-IN", {
    day:   "2-digit",
    month: "long",
    year:  "numeric",
  });
});

module.exports = mongoose.model("HolidayCalendar", holidayCalendarSchema);