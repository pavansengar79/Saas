// modules/tenant/tenant.controller.js
//
// Task 16 — UPDATED (corrected)
//
// registerOrg() is the only public endpoint.
// Super Admin CRUD now operates on Customer documents.

const tenantService = require("./tenant.service");  

// POST /tenant/register  — public
exports.registerOrg = async (req, res, next) => {
  try {
    const result = await tenantService.registerOrg(req.body);
    return res.status(201).json({
      success: true,
      message: result.message,
      data:    result,
    });
  } catch (error) {
    next(error);
  }
};

// Super Admin — list all customers
exports.getCustomers = async (req, res, next) => {
  try {
    const customers = await tenantService.getCustomers();
    return res.status(200).json({ success: true, data: customers });
  } catch (error) {
    next(error);
  }
};

exports.getCustomerById = async (req, res, next) => {
  try {
    const customer = await tenantService.getCustomerById(req.params.id);
    return res.status(200).json({ success: true, data: customer });
  } catch (error) {
    next(error);
  }
};

exports.updateCustomer = async (req, res, next) => {
  try {
    const customer = await tenantService.updateCustomer(req.params.id, req.body);
    return res.status(200).json({ success: true, data: customer });
  } catch (error) {
    next(error);
  }
};

exports.deleteCustomer = async (req, res, next) => {
  try {
    const result = await tenantService.deleteCustomer(req.params.id);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};