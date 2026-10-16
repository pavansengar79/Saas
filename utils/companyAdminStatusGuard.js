const User = require('../modules/auth/models/user.model');
const Role = require('../modules/role/role.model');
const AppError = require('./appError');

// A linked Employee record can also change User.status. Require an explicit
// acknowledgement before either API disables an active Company Admin login.
async function assertCompanyAdminDeactivationConfirmed(userId, nextStatus, confirmed) {
  if (nextStatus !== 'INACTIVE' && nextStatus !== 'BLOCKED') return;

  const user = await User.findById(userId).select('status roleId').lean();
  if (!user || user.status !== 'ACTIVE') return;

  const role = await Role.findById(user.roleId).select('slug').lean();
  if (role?.slug === 'company_admin' && confirmed !== true) {
    throw new AppError('Deactivating a Company Admin requires confirmCompanyAdminDeactivation: true', 400);
  }
}

module.exports = { assertCompanyAdminDeactivationConfirmed };