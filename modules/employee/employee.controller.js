// employee.controller.js
const employeeService = require("./employee.service");

exports.createEmployee = async (req, res, next) => {
  try {

    const employee = await employeeService.createEmployee(req.body, req.user);

    return res.status(201).json({
      success: true,
      message: "Employee created successfully",
      data: employee
    });

  } catch (error) {
    next(error);
  }
};

exports.getEmployees = async (req, res, next) => {
  try {

    const result = await employeeService.getEmployees(req.user, req.query);

    return res.status(200).json({
      success: true,
      message: "Employees fetched successfully",
      data:    result.employees,
      pagination: result.pagination
    });

  } catch (error) {
    next(error);
  }
};

exports.downloadMyDocument = async (req, res, next) => {
  try {
    const url = await employeeService.downloadMyDocument(req.params.docId, req.user);
    res.redirect(url);
  } catch (error) { next(error); }
};

exports.getEmployeeById = async (req, res, next) => {
  try {

    const employee = await employeeService.getEmployeeById(req.params.id, req.user);

    return res.status(200).json({
      success: true,
      message: "Employee fetched successfully",
      data: employee
    });

  } catch (error) {
    next(error);
  }
};

exports.updateEmployee = async (req, res, next) => {
  try {

    const employee = await employeeService.updateEmployee(
      req.params.id,
      req.body,
      req.user
    );

    return res.status(200).json({
      success: true,
      message: "Employee updated successfully",
      data: employee
    });

  } catch (error) {
    next(error);
  }
};
exports.deleteEmployee = async (req, res, next) => {
  try {

    const result = await employeeService.deleteEmployee(
      req.params.id,
      req.user,
      req.body?.confirmCompanyAdminDeactivation
    );

    return res.status(200).json({
      success: true,
      message: result.message
    });

  } catch (error) {
    next(error);
  }
};

exports.activateLogin = async (req, res, next) => {
  try {

    const result = await employeeService.activateLogin(
      req.params.id,
      req.body,
      req.user
    );

    return res.status(200).json({
      success: true,
      message: result.message,
      data: result
    });

  } catch (error) {
    next(error);
  }
};

exports.uploadDocument = async (req, res, next) => {
  try {
    const document = await employeeService.uploadDocument(
      req.params.id,
      req.body,
      req.file,    // File provided by Multer
      req.user
    );

    return res.status(201).json({
      success: true,
      message: "Document uploaded successfully",
      data:    document
    });
  } catch (error) {
    next(error);
  }
};

exports.getDocuments = async (req, res, next) => {
  try {
    const documents = await employeeService.getDocuments(
      req.params.id,
      req.user
    );

    return res.status(200).json({
      success: true,
      message: "Documents fetched successfully",
      data:    documents
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteDocument = async (req, res, next) => {
  try {
    const result = await employeeService.deleteDocument(
      req.params.id,
      req.params.docId,
      req.user
    );

    return res.status(200).json({
      success: true,
      message: result.message
    });
  } catch (error) {
    next(error);
  }
};

exports.verifyDocument = async (req, res, next) => {
  try {
    const document = await employeeService.verifyDocument(
      req.params.id,
      req.params.docId,
      req.user
    );

    return res.status(200).json({
      success: true,
      message: "Document verified successfully",
      data:    document
    });
  } catch (error) {
    next(error);
  }
};

// Employee status change handler

exports.changeStatus = async (req, res, next) => {
  try {
    const result = await employeeService.changeStatus(
      req.params.id,
      req.body,
      req.user
    );
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
// E-08
exports.getMyProfile = async (req, res, next) => {
  try {
    const data = await employeeService.getMyProfile(req.user);
    res.status(200).json({ success: true, message: "Profile fetched", data });
  } catch (error) { next(error); }
};

// E-09
exports.getMyDocuments = async (req, res, next) => {
  try {
    const data = await employeeService.getMyDocuments(req.user);
    res.status(200).json({ success: true, message: "Documents fetched", data });
  } catch (error) { next(error); }
};

// E-10
exports.getProfileCompletion = async (req, res, next) => {
  try {
    const data = await employeeService.getProfileCompletion(req.user);
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};