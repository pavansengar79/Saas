const ShiftSwapRequest = require('../modules/shift/models/shiftSwapRequest.model');

async function runShiftSwapExpiry() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await ShiftSwapRequest.updateMany(
    {
      status: { $in: ['PENDING_ACCEPTANCE', 'PENDING_APPROVAL'] },
      swapDate: { $lt: today },
      is_deleted: false,
    },
    { $set: { status: 'EXPIRED' } }
  );

  return { expired: result.modifiedCount };
}

module.exports = { runShiftSwapExpiry };