const moment = require('moment-timezone');
const AppError = require('../../utils/appError');
const { sessionHours } = require('./attendanceMetrics');
const { creditedOvertime } = require('./creditedOvertime');

// A correction changes the first arrival and/or last departure. Preserve any
// intervening breaks rather than treating the whole span as working time.
const correctAttendanceTimes = (record, checkIn, checkOut, timezone, config, policy) => {
  const sessions = record.sessions?.length
    ? record.sessions.map(session => ({ checkIn: session.checkIn, checkOut: session.checkOut }))
    : (record.checkIn ? [{ checkIn: record.checkIn, checkOut: record.checkOut }] : []);

  if (checkIn) {
    if (sessions.length) sessions[0].checkIn = new Date(checkIn);
    else sessions.push({ checkIn: new Date(checkIn), checkOut: null });
  }
  if (checkOut) {
    if (!sessions.length) throw new AppError('Check-in is required before check-out', 400);
    sessions[sessions.length - 1].checkOut = new Date(checkOut);
  }

  for (let i = 0; i < sessions.length; i++) {
    const current = sessions[i];
    if (Number.isNaN(new Date(current.checkIn).getTime()) ||
        (current.checkOut && (Number.isNaN(new Date(current.checkOut).getTime()) ||
          new Date(current.checkOut) < new Date(current.checkIn))) ||
        (i > 0 && (!sessions[i - 1].checkOut ||
          new Date(current.checkIn) < new Date(sessions[i - 1].checkOut)))) {
      throw new AppError('Corrected work sessions must be chronological and non-overlapping', 400);
    }
  }

  record.sessions = sessions;
  record.checkIn = sessions[0]?.checkIn || null;
  record.checkOut = sessions[sessions.length - 1]?.checkOut || null;
  const complete = sessions.length > 0 && sessions.every(session => session.checkOut);
  record.workingHours = complete ? sessionHours(sessions) : null;
  record.overtimeHours = complete
    ? creditedOvertime(record, record.checkOut, record.workingHours, timezone, config, policy)
    : 0;

  if (record.checkIn && record.shiftStart) {
    const [hour, minute] = record.shiftStart.split(':').map(Number);
    const shiftStart = moment(record.date).tz(timezone).startOf('day')
      .add(hour, 'hours').add(minute, 'minutes');
    const lateness = moment(record.checkIn).diff(shiftStart, 'minutes') - (record.graceMinutes ?? 15);
    record.lateMinutes = Math.max(0, lateness);
    record.isLate = lateness > 0;
  }
  return record;
};

module.exports = { correctAttendanceTimes };
