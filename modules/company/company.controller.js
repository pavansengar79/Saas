// modules/company/company.controller.js

const companyService = require("./company.service");
const AppError = require("../../utils/appError");

exports.createCompany = async (req, res, next) => {
  try {
    const company = await companyService.createCompany(req.body, req.user);
    return res.status(201).json({ success: true, message: company.message, data: company });
  } catch (err) { next(err); }
};

exports.getCompanies = async (req, res, next) => {
  try {
    const result = await companyService.getCompanies(req.user, req.query);
    return res.status(200).json({ success: true, ...result });
  } catch (err) { next(err); }
};

exports.getCompanyById = async (req, res, next) => {
  try {
    const company = await companyService.getCompanyById(req.params.id, req.user);
    return res.status(200).json({ success: true, data: company });
  } catch (err) { next(err); }
};

exports.updateCompany = async (req, res, next) => {
  try {
    const company = await companyService.updateCompany(req.params.id, req.body, req.user);
    return res.status(200).json({ success: true, message: "Company updated successfully", data: company });
  } catch (err) { next(err); }
};

exports.deleteCompany = async (req, res, next) => {
  try {
    const result = await companyService.deleteCompany(req.params.id, req.user);
    return res.status(200).json({ success: true, ...result });
  } catch (err) { next(err); }
};

// ─── POST /api/v1/company/logo (Upload) ─────────────────────
exports.uploadLogo = async (req, res, next) => {
  try {
    if (!req.user.company_id) {
      return next(new AppError("Company ID not found in user context", 400));
    }

    if (!req.file) {
      return next(new AppError("No file uploaded", 400));
    }

    // File uploaded to Cloudinary via multer middleware
    const logoUrl = req.file.path; // Cloudinary URL

    const Company = require("./models/company.model");
    const company = await Company.findByIdAndUpdate(
      req.user.company_id,
      { logo_url: logoUrl },
      { new: true }
    ).select("logo_url");

    if (!company) {
      return next(new AppError("Company not found", 404));
    }

    res.json({
      success: true,
      message: "Company logo uploaded successfully",
      data: { logo_url: company.logo_url },
    });
  } catch (err) {
    next(err);
  }
};

exports.removeLogo = async (req, res, next) => {
  try {
    if (!req.user.company_id) {
      return next(new AppError("Company ID not found in user context", 400));
    }

    const Company = require("./models/company.model");
    const company = await Company.findByIdAndUpdate(
      req.user.company_id,
      { logo_url: null },
      { new: true }
    ).select("logo_url");

    if (!company) {
      return next(new AppError("Company not found", 404));
    }

    res.json({
      success: true,
      message: "Company logo removed successfully",
      data: { logo_url: null },
    });
  } catch (err) {
    next(err);
  }
};