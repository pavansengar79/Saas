const { test } = require('node:test');
const assert = require('node:assert/strict');
const { monthRange, summarizeAttendance, sessionHours } = require('./attendanceMetrics');
const { creditedOvertime, uncreditedOvertimeHours } = require('./creditedOvertime');
const { daysInYear, earnedCredits } = require('../leave/leaveAccounting');

for (const [tz, month, expectedStart, expectedEnd] of [
  ['Asia/Kolkata', '2026-10', '2026-09-30T18:30:00.000Z', '2026-10-31T18:30:00.000Z'],
  ['America/New_York', '2026-03', '2026-03-01T05:00:00.000Z', '2026-04-01T04:00:00.000Z'],
  ['UTC', '2026-10', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
]) {
  test(`month boundaries ${tz} ${month}`, () => {
    const range = monthRange(month, tz);
    assert.equal(range.start.toISOString(), expectedStart);
    assert.equal(range.end.toISOString(), expectedEnd);
  });
}

test('late WFH and half-day are independently counted as attended, not absent', () => {
  const result = summarizeAttendance([
    { checkIn: new Date(), status: 'LATE', isWFH: true, isLate: true },
    { checkIn: new Date(), status: 'HALF_DAY', isWFH: true, isLate: true },
    { status: 'ABSENT' }, { status: 'ON_LEAVE' }, { status: 'PRESENT' },
  ]);
  assert.deepEqual(result, { present: 3, absent: 1, late: 2, wfh: 2, halfDay: 1, onLeave: 1 });
});

test('resumed punches exclude the break and unfinished interval', () => {
  assert.equal(sessionHours([
    { checkIn: '2026-10-15T09:00:00Z', checkOut: '2026-10-15T10:00:00Z' },
    { checkIn: '2026-10-15T13:00:00Z', checkOut: '2026-10-15T17:30:00Z' },
  ]), 5.5);
  assert.equal(sessionHours([{ checkIn: '2026-10-15T09:00:00Z' }]), 0);
});

test('cross-year leave is charged only to its respective years', () => {
  const request = { startDate: new Date('2026-12-31'), endDate: new Date('2027-01-01'), totalDays: 2 };
  assert.equal(daysInYear(request, 2026), 1);
  assert.equal(daysInYear(request, 2027), 1);
  assert.equal(daysInYear({ ...request, totalDays: 1 }, 2027), 0.5);
});

test('monthly earned credits are not the full annual allocation', () => {
  const policy = { totalPerYear: 12, accrualType: 'MONTHLY', perCycle: 1, accrualDay: 1 };
  assert.equal(earnedCredits(policy, 2026, new Date('2026-03-15')), 3);
  assert.equal(earnedCredits(policy, 2027, new Date('2026-03-15')), 0);
  assert.equal(earnedCredits(policy, 2026, new Date('2026-03-15'), new Date('2026-02-05')), 1);
});

test('overtime is capped by actual worked hours, policy and company threshold', () => {
  const record = { date: new Date('2026-10-15T18:30:00Z'), shiftEnd: '18:00', standardHours: 8 };
  const checkout = new Date('2026-10-16T14:30:00Z'); // 20:00 IST
  const policy = { overtime: { enabled: true, minimumMinutes: 30, maxHoursPerDay: 1 } };
  assert.equal(creditedOvertime(record, checkout, 9.5, 'Asia/Kolkata', { overtimeThresholdHours: 9 }, policy), 1);
  assert.equal(creditedOvertime(record, checkout, 8.5, 'Asia/Kolkata', { overtimeThresholdHours: 9 }, policy), 0);
  assert.equal(creditedOvertime(record, checkout, 10, 'Asia/Kolkata', { overtimeEnabled: false }, policy), 0);
});

test('overtime follows punch-in day when the stored attendance date is offset', () => {
  const record = {
    date: new Date('2026-10-15T18:30:00Z'),
    checkIn: new Date('2026-10-15T02:38:00Z'),
    shiftEnd: '18:00',
    standardHours: 8,
  };
  const checkout = new Date('2026-10-15T16:38:00Z');
  const policy = { overtime: { enabled: true, minimumMinutes: 60, maxHoursPerDay: 4 } };
  assert.equal(creditedOvertime(record, checkout, 14, 'Asia/Kolkata', { overtimeThresholdHours: 9 }, policy), 4);
  assert.equal(uncreditedOvertimeHours({ ...record, checkOut: checkout, workingHours: 14, overtimeHours: 0 },
    'Asia/Kolkata', { overtimeThresholdHours: 9 }, policy), 4);
  assert.equal(uncreditedOvertimeHours({ ...record, checkOut: checkout, workingHours: 14, overtimeHours: 4 },
    'Asia/Kolkata', { overtimeThresholdHours: 9 }, policy), 0);
  assert.equal(uncreditedOvertimeHours({ ...record, date: record.checkIn, checkOut: checkout, workingHours: 14 },
    'Asia/Kolkata', { overtimeThresholdHours: 9 }, policy), 0);
  assert.equal(uncreditedOvertimeHours({ ...record, checkOut: checkout, workingHours: 14 },
    'Asia/Kolkata', { overtimeEnabled: false }, policy), 0);
});
