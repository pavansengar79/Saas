const moment = require('moment-timezone');
const { workWeekSet, isWorkDayIndex } = require('../../utils/timezone');

// Preserve the request's charged totalDays (including half-days/sandwich rules)
// while distributing a multi-year request according to its working-day dates.
// L-04: workWeek = CompanyConfig.workWeek (Mon–Fri only as fallback)
const daysInYear = (request, year, workWeek) => {
  const start = moment.utc(request.startDate).startOf('day');
  const end = moment.utc(request.endDate).startOf('day');
  if (!start.isValid() || !end.isValid() || end.isBefore(start)) return 0;
  if (start.year() === end.year()) return start.year() === year ? request.totalDays : 0;
  const workDays = workWeekSet(workWeek);
  let all = 0;
  let inYear = 0;
  for (const day = start.clone(); day.isSameOrBefore(end); day.add(1, 'day')) {
    if (!isWorkDayIndex(day.day(), workDays)) continue;
    all++;
    if (day.year() === year) inYear++;
  }
  return all ? Number((request.totalDays * inYear / all).toFixed(2)) : 0;
};

const earnedCredits = (credit, year, asOf = new Date(), joiningDate = null) => {
  const annual = credit?.totalPerYear || 0;
  const frequency = credit?.accrualType || credit?.frequency || 'YEARLY';
  if (frequency === 'YEARLY' || frequency === 'NONE') return annual;
  const period = frequency === 'QUARTERLY' ? 3 : 1;
  const now = moment.utc(asOf);
  const cutoff = now.year() === year ? now : moment.utc(`${year}-12-31`);
  if (now.year() < year) return 0;
  const joined = joiningDate ? moment.utc(joiningDate) : null;
  const dayOfCycle = credit.accrualDay || 1;
  let cycles = 0;
  for (let month = 0; month < 12; month += period) {
    const date = moment.utc([year, month, Math.min(dayOfCycle, moment.utc([year, month]).daysInMonth())]);
    if (date.isAfter(cutoff) || (joined && joined.isAfter(date))) continue;
    cycles++;
  }
  const raw = Math.min(annual, cycles * (credit.perCycle || annual / (12 / period)));
  const round = { FLOOR: Math.floor, CEIL: Math.ceil, ROUND: Math.round }[credit.roundingRule] || Math.round;
  return round(raw * 2) / 2;
};

module.exports = { daysInYear, earnedCredits };