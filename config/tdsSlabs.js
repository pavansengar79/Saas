// config/tdsSlabs.js
// TDS Calculation for Old and New Tax Regimes
// Updated for FY 2026-27 (AY 2027-28)

"use strict";

/**
 * TDS slabs for Old Tax Regime (FY 2026-27)
 * For age < 60 years
 * Applicable when employee opts for old regime
 */
const OLD_REGIME_SLABS = [
  { min: 0, max: 250000, rate: 0 },
  { min: 250001, max: 500000, rate: 5 },
  { min: 500001, max: 1000000, rate: 20 },
  { min: 1000001, max: null, rate: 30 },
];

/**
 * TDS slabs for Old Tax Regime - Senior Citizens (60-80 years)
 */
const OLD_REGIME_SLABS_SENIOR = [
  { min: 0, max: 300000, rate: 0 },
  { min: 300001, max: 500000, rate: 5 },
  { min: 500001, max: 1000000, rate: 20 },
  { min: 1000001, max: null, rate: 30 },
];

/**
 * TDS slabs for Old Tax Regime - Super Senior Citizens (80+ years)
 */
const OLD_REGIME_SLABS_SUPER_SENIOR = [
  { min: 0, max: 500000, rate: 0 },
  { min: 500001, max: 1000000, rate: 20 },
  { min: 1000001, max: null, rate: 30 },
];

/**
 * TDS slabs for New Tax Regime (FY 2025-26 onwards, Section 115BAC)
 * Default regime from FY 2023-24
 */
const NEW_REGIME_SLABS = [
  { min: 0, max: 400000, rate: 0 },
  { min: 400000, max: 800000, rate: 5 },
  { min: 800000, max: 1200000, rate: 10 },
  { min: 1200000, max: 1600000, rate: 15 },
  { min: 1600000, max: 2000000, rate: 20 },
  { min: 2000000, max: 2400000, rate: 25 },
  { min: 2400000, max: null, rate: 30 },
];

/**
 * Rebate under Section 87A
 * Old Regime: Up to ₹5 lakh taxable income → Full rebate (max ₹12,500)
 * New Regime: Up to 12 lakh taxable income, rebate up to 60,000
 */
const REBATE_87A = {
  old: {
    maxIncome: 500000,
    maxRebate: 12500,
  },
  new: {
    maxIncome: 1200000,
    maxRebate: 60000,
  },
};

/**
 * Standard Deduction
 * Old Regime: ₹50,000 (from FY 2019-20)
 * New Regime: 75,000 (from FY 2024-25)
 */
const STANDARD_DEDUCTION = 50000;
const NEW_REGIME_STANDARD_DEDUCTION = 75000;

/**
 * Surcharge Rates (applicable on income tax)
 * Both regimes (slightly different slabs)
 */
const SURCHARGE_OLD = [
  { min: 5000000, max: 10000000, rate: 10 },
  { min: 10000001, max: 20000000, rate: 15 },
  { min: 20000001, max: null, rate: 25 }, // Cap at 15% for capital gains
];

const SURCHARGE_NEW = [
  { min: 5000001, max: 10000000, rate: 10 },
  { min: 10000001, max: 20000000, rate: 15 },
  { min: 20000001, max: null, rate: 25 },
];

/**
 * Health and Education Cess
 * 4% on (Tax + Surcharge)
 */
const CESS_RATE = 4;

/**
 * Calculate TDS for Old Regime
 * @param {number} annualTaxableIncome - Annual taxable income
 * @param {string} ageGroup - 'general', 'senior', 'super_senior'
 * @returns {object} - Tax calculation breakdown
 */
function calculateTDSOldRegime(annualTaxableIncome, ageGroup = 'general') {
  let slabs = OLD_REGIME_SLABS;
  
  if (ageGroup === 'senior') {
    slabs = OLD_REGIME_SLABS_SENIOR;
  } else if (ageGroup === 'super_senior') {
    slabs = OLD_REGIME_SLABS_SUPER_SENIOR;
  }
  
  let tax = 0;
  let remainingIncome = annualTaxableIncome;
  
  for (const slab of slabs) {
    if (remainingIncome <= 0) break;
    
    const slabMin = slab.min;
    const slabMax = slab.max || Infinity;
    const taxRate = slab.rate / 100;
    
    if (annualTaxableIncome > slabMin) {
      const taxableInSlab = Math.min(
        remainingIncome,
        slabMax === Infinity ? remainingIncome : slabMax - slabMin
      );
      tax += taxableInSlab * taxRate;
      remainingIncome -= taxableInSlab;
    }
  }
  
  // Apply Section 87A rebate
  let rebate = 0;
  if (annualTaxableIncome <= REBATE_87A.old.maxIncome) {
    rebate = Math.min(tax, REBATE_87A.old.maxRebate);
    tax -= rebate;
  }
  
  // Calculate surcharge
  let surcharge = 0;
  for (const slab of SURCHARGE_OLD) {
    if (annualTaxableIncome > slab.min) {
      surcharge = tax * (slab.rate / 100);
    }
  }
  
  // Calculate cess (4% on tax + surcharge)
  const cess = (tax + surcharge) * (CESS_RATE / 100);
  
  const totalTax = tax + surcharge + cess;
  
  return {
    taxableIncome: annualTaxableIncome,
    grossTax: tax + rebate,
    rebate87A: rebate,
    taxAfterRebate: tax,
    surcharge,
    cess,
    totalTax,
    monthlyTDS: Math.ceil(totalTax / 12),
  };
}

/**
 * Calculate TDS for New Regime (Section 115BAC)
 * @param {number} annualTaxableIncome - Annual taxable income
 * @returns {object} - Tax calculation breakdown
 */
function calculateTDSNewRegime(annualTaxableIncome) {
  let tax = 0;
  let remainingIncome = annualTaxableIncome;
  
  for (const slab of NEW_REGIME_SLABS) {
    if (remainingIncome <= 0) break;
    
    const slabMin = slab.min;
    const slabMax = slab.max || Infinity;
    const taxRate = slab.rate / 100;
    
    if (annualTaxableIncome > slabMin) {
      const taxableInSlab = Math.min(
        remainingIncome,
        slabMax === Infinity ? remainingIncome : slabMax - slabMin
      );
      tax += taxableInSlab * taxRate;
      remainingIncome -= taxableInSlab;
    }
  }
  
  // Apply Section 87A rebate (new regime)
  let rebate = 0;
  if (annualTaxableIncome <= REBATE_87A.new.maxIncome) {
    rebate = Math.min(tax, REBATE_87A.new.maxRebate);
    tax -= rebate;
  }
  const marginalRelief = annualTaxableIncome > REBATE_87A.new.maxIncome
    ? Math.max(0, tax - (annualTaxableIncome - REBATE_87A.new.maxIncome))
    : 0;
  tax -= marginalRelief;
  
  // Calculate surcharge
  let surcharge = 0;
  for (const slab of SURCHARGE_NEW) {
    if (annualTaxableIncome > slab.min) {
      surcharge = tax * (slab.rate / 100);
    }
  }
  
  // Calculate cess (4% on tax + surcharge)
  const cess = (tax + surcharge) * (CESS_RATE / 100);
  
  const totalTax = tax + surcharge + cess;
  
  return {
    taxableIncome: annualTaxableIncome,
    grossTax: tax + rebate + marginalRelief,
    rebate87A: rebate,
    marginalRelief,
    taxAfterRebate: tax,
    surcharge,
    cess,
    totalTax,
    monthlyTDS: Math.ceil(totalTax / 12),
  };
}

/**
 * Get applicable exemptions for old regime
 * (New regime has minimal exemptions)
 */
const OLD_REGIME_EXEMPTIONS = {
  standardDeduction: 50000,
  hraExemption: true,
  ltaExemption: true,
  deductions80C: true,
  deductions80D: true,
  deductions80E: true,
  deductions80EEA: true,
  deductions80TTA: true,
  professionalTaxExempt: true,
  entertainmentAllowance: true,
  employmentTaxExempt: true,
};

const NEW_REGIME_EXEMPTIONS = {
  standardDeduction: NEW_REGIME_STANDARD_DEDUCTION,
  hraExemption: false,
  ltaExemption: false,
  deductions80C: false,
  deductions80D: false,
  deductions80E: false,
  deductions80EEA: false,
  deductions80TTA: false,
  professionalTaxExempt: false,
  entertainmentAllowance: false,
  employmentTaxExempt: false,
};

/**
 * Compare tax under both regimes
 * @param {number} grossIncome - Annual gross income
 * @param {object} investments - Total declared investments/exemptions
 * @param {string} ageGroup - 'general', 'senior', 'super_senior'
 * @returns {object} - Comparison of both regimes
 */
function compareTaxRegimes(grossIncome, investments = {}, ageGroup = 'general') {
  // Old regime calculation with exemptions
  const oldTaxableIncome = Math.max(0, grossIncome
    - STANDARD_DEDUCTION
    - (investments.hraExemption || 0)
    - (investments.ltaExemption || 0)
    - Math.min(investments.total80C || 0, 150000)
    - Math.min(investments.total80CCD || 0, 50000)
    - Math.min(investments.total80D || 0, 100000)
    - (investments.total80E || 0)
    - Math.min(investments.total80EEA || 0, 150000)
    - Math.min(investments.total80TTA || 0, 10000)
    - (investments.professionalTax || 0)
  );
  
  // New regime calculation (minimal exemptions)
  const newTaxableIncome = Math.max(0, grossIncome - NEW_REGIME_STANDARD_DEDUCTION);
  
  const oldCalc = calculateTDSOldRegime(oldTaxableIncome, ageGroup);
  const newCalc = calculateTDSNewRegime(newTaxableIncome);
  
  const savings = oldCalc.totalTax - newCalc.totalTax;
  
  return {
    oldRegime: oldCalc,
    newRegime: newCalc,
    recommendedRegime: savings > 0 ? 'new' : 'old',
    savings: Math.abs(savings),
  };
}

module.exports = {
  OLD_REGIME_SLABS,
  OLD_REGIME_SLABS_SENIOR,
  OLD_REGIME_SLABS_SUPER_SENIOR,
  NEW_REGIME_SLABS,
  REBATE_87A,
  STANDARD_DEDUCTION,
  NEW_REGIME_STANDARD_DEDUCTION,
  SURCHARGE_OLD,
  SURCHARGE_NEW,
  CESS_RATE,
  OLD_REGIME_EXEMPTIONS,
  NEW_REGIME_EXEMPTIONS,
  calculateTDSOldRegime,
  calculateTDSNewRegime,
  compareTaxRegimes,
};
