const moment = require('moment-timezone');

const monthRange = (month, timezone = 'Asia/Kolkata') => {
  const start = moment.tz(`${month}-01`, 'YYYY-MM-DD', true, timezone);
  if (!start.isValid() || start.format('YYYY-MM') !== month) {
    throw new Error('Invalid month; expected YYYY-MM');
  }
  return { start: start.toDate(), end: start.clone().add(1, 'month').toDate() };
};

// Present is an inclusive "attended" count; late, WFH and half-day are
// independent dimensions and must not be added together with present.
const attendanceFlags = (record) => {
  const attended = !!record.checkIn || ['PRESENT', 'WFH', 'LATE', 'HALF_DAY'].includes(record.status);
  return {
    present: attended,
    absent: !attended && record.status === 'ABSENT',
    late: attended && (record.isLate === true || record.status === 'LATE'),
    wfh: attended && (record.isWFH === true || record.status === 'WFH'),
    halfDay: attended && record.status === 'HALF_DAY',
    onLeave: !attended && record.status === 'ON_LEAVE',
  };
};

const summarizeAttendance = (records) => {
  const result = { present: 0, absent: 0, late: 0, wfh: 0, halfDay: 0, onLeave: 0 };
  for (const record of records) {
    const flags = attendanceFlags(record);
    for (const key of Object.keys(result)) if (flags[key]) result[key]++;
  }
  return result;
};

const sessionHours = (sessions) => Number((sessions.reduce((total, session) => {
  if (!session.checkOut || !session.checkIn) return total;
  const duration = new Date(session.checkOut) - new Date(session.checkIn);
  return total + Math.max(0, duration) / 3600000;
}, 0)).toFixed(2));

module.exports = { monthRange, attendanceFlags, summarizeAttendance, sessionHours };