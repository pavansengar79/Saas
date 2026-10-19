// modules/holiday/models/holidayMaster.model.js
//
// Platform-level master list of national holidays
// No company_id — these are reference holidays
// HR imports from this list into their company

const mongoose = require("mongoose");

const holidayMasterSchema = new mongoose.Schema(
  {
    name: {
      type:     String,
      required: true,
      trim:     true,
    },

    date: {
      type:     Date,
      required: true,
    },

    type: {
      type:    String,
      enum:    ["NATIONAL", "OPTIONAL", "REGIONAL", "RELIGIOUS", "COMPANY"],
      default: "NATIONAL",
    },

    country: {
      type:    String,
      default: "IN",
      index:   true,
    },

    year: {
      type:  Number,
      index: true,
    },

    isRecurring: {
      type:    Boolean,
      default: false,
    },

    isActive: {
      type:    Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

holidayMasterSchema.index({ country: 1, year: 1 });
holidayMasterSchema.index({ country: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("HolidayMaster", holidayMasterSchema);