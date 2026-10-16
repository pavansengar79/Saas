// modules/company/companyModule.controller.js
//
// Company Module Management — handled by the Org Admin
//
// GET  /companies/:id/modules
//   → return all company modules (compared against org modules)
//   → shows which are active/inactive for this specific company
//
// PUT  /companies/:id/modules
//   → body: { modules: [{ module_id, is_active }] }
//   → enable/disable modules for a company
//   → Rule enforced in service: cannot enable if OrgModule is OFF

const companyModuleService = require("./companyModule.service");

exports.getCompanyModules = async (req, res, next) => {
  try {
    const data = await companyModuleService.getCompanyModules(req.params.id, req.user);
    return res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

exports.updateCompanyModules = async (req, res, next) => {
  try {
    const data = await companyModuleService.updateCompanyModules(req.params.id, req.body.modules, req.user);
    return res.status(200).json({ success: true, message: "Company modules updated", data });
  } catch (err) { next(err); }
};