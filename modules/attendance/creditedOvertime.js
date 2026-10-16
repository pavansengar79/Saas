const { calculateOvertime } = require('../../utils/timezone');
const { calculatePolicyOvertime } = require('./overtimeCalculator');

const creditedOvertime = (record, checkout, workingHours, timezone, config, policy) => {
  if (config?.overtimeEnabled === false || !record.shiftEnd) return 0;
  const afterShift = calculateOvertime(checkout, record.shiftEnd, record.isNextDay,
    record.date, timezone, 0);
  const extraWorked = Math.max(0, workingHours - (record.standardHours || 8));
  const threshold = Math.max(0, (config?.overtimeThresholdHours || 0) - (record.standardHours || 8));
  const eligible = Math.min(afterShift, extraWorked);
  if (eligible < threshold) return 0;
  return calculatePolicyOvertime(eligible, policy?.overtime);
};

module.exports = { creditedOvertime };