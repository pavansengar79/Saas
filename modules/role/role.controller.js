// modules/role/role.controller.js
// UPDATED — tenantId removed; pass req.user to the service

const roleService = require("./role.service");

exports.createRole = async (req, res, next) => {
  try {
    const role = await roleService.createRole(req.body, req.user);
    return res.status(201).json({ success: true, message: "Role created successfully", data: role });
  } catch (error) { next(error); }
};

exports.getRoles = async (req, res, next) => {
  try {
    const roles = await roleService.getRoles(req.user);
    return res.status(200).json({ success: true, message: "Roles fetched successfully", data: roles });
  } catch (error) { next(error); }
};

exports.getRoleById = async (req, res, next) => {
  try {
    const role = await roleService.getRoleById(req.params.id, req.user);
    return res.status(200).json({ success: true, message: "Role fetched successfully", data: role });
  } catch (error) { next(error); }
};

exports.updateRole = async (req, res, next) => {
  try {
    const updatedRole = await roleService.updateRole(req.params.id, req.body, req.user);
    return res.status(200).json({ success: true, message: "Role updated successfully", data: updatedRole });
  } catch (error) { next(error); }
};

exports.deleteRole = async (req, res, next) => {
  try {
    await roleService.deleteRole(req.params.id, req.user);
    return res.status(200).json({ success: true, message: "Role deleted successfully" });
  } catch (error) { next(error); }
};

// T-03 — Update role module access
exports.updateRoleModules = async (req, res, next) => {
  try {
    const result = await roleService.updateRoleModules(req.params.id, req.body, req.user);
    res.json({ success: true, message: "Role modules updated", data: result });
  } catch (err) { next(err); }
};

exports.getAssignablePermissions = async (req, res, next) => {
  try {
    const perms = await roleService.getAssignablePermissions(req.user);
    return res.status(200).json({ success: true, data: perms });
  } catch (err) { next(err); }
};