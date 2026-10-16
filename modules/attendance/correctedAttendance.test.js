const assert = require('node:assert/strict');
const { test } = require('node:test');
const { correctAttendanceTimes } = require('./correctedAttendance');

const date = new Date('2026-10-15T18:30:00Z'); // Oct 16 IST
const record = () => ({
  date, shiftStart: '09:00', shiftEnd: '17:00', standardHours: 8,
  checkIn: new Date('2026-10-16T03:30:00Z'),
  checkOut: new Date('2026-10-16T13:30:00Z'),
  sessions: [
    { checkIn: new Date('2026-10-16T03:30:00Z'), checkOut: new Date('2026-10-16T07:30:00Z') },
    { checkIn: new Date('2026-10-16T08:30:00Z'), checkOut: new Date('2026-10-16T13:30:00Z') },
  ],
});

test('correction retains unpaid break, updates outer punches, and checks local lateness', () => {
  const attendance = record();
  correctAttendanceTimes(attendance, new Date('2026-10-16T04:00:00Z'),
    new Date('2026-10-16T14:30:00Z'), 'Asia/Kolkata', { overtimeEnabled: false }, {});
  assert.equal(attendance.workingHours, 9.5);
  assert.equal(attendance.overtimeHours, 0);
  assert.equal(attendance.lateMinutes, 15);
  assert.equal(attendance.isLate, true);
  assert.equal(attendance.sessions.length, 2);
});

test('correction rejects overlap without changing original session collection', () => {
  const attendance = record();
  assert.throws(() => correctAttendanceTimes(attendance, new Date('2026-10-16T09:30:00Z'),
    null, 'Asia/Kolkata', {}, {}), /chronological/);
  assert.equal(attendance.sessions[0].checkIn.toISOString(), '2026-10-16T03:30:00.000Z');
});

test('legacy one-punch record becomes one interval and clears stale hours', () => {
  const attendance = { date, checkIn: new Date('2026-10-16T03:30:00Z'),
    checkOut: null, workingHours: 12, overtimeHours: 4 };
  correctAttendanceTimes(attendance, null, null, 'Asia/Kolkata', {}, {});
  assert.equal(attendance.workingHours, null);
  assert.equal(attendance.overtimeHours, 0);
  assert.equal(attendance.sessions.length, 1);
});
