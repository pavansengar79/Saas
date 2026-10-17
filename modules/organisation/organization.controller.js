// modules/organisation/organization.controller.js

const Organization = require("./models/organization.model");
const AppError = require("../../utils/appError");
const Company = require("../company/models/company.model");
const Unit = require("../unit/models/unit.model");
const Department = require("../department/department.model");
const Employee = require("../employee/models/employee.model");
const LOB = require("../lob/models/lob.model");

// ─── GET /api/v1/organization/config ─────────────────────
exports.getConfig = async (req, res, next) => {
  try {
    if (!req.user.orgId) {
      return next(new AppError("Organization ID not found in user context", 400));
    }

    const org = await Organization.findById(req.user.orgId).select(
      "name logo_url address timezone currency fiscalYearStart industry country contact_email contact_phone"
    );

    if (!org) {
      return next(new AppError("Organization not found", 404));
    }

    res.json({
      success: true,
      message: "Organization config fetched successfully",
      data: org,
    });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/v1/organization/config ─────────────────────
exports.updateConfig = async (req, res, next) => {
  try {
    if (!req.user.orgId) {
      return next(new AppError("Organization ID not found in user context", 400));
    }

    const allowedUpdates = [
      "logo_url",
      "address",
      "timezone",
      "currency",
      "fiscalYearStart",
      "industry",
      "country",
      "contact_email",
      "contact_phone",
    ];

    const updates = {};
    allowedUpdates.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    // Validate timezone if provided
    if (updates.timezone) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: updates.timezone });
      } catch {
        return next(new AppError("Invalid IANA timezone. Example: Asia/Kolkata", 400));
      }
    }

    // Validate currency if provided
    if (updates.currency && !/^[A-Z]{3}$/.test(updates.currency.toUpperCase())) {
      return next(new AppError("Invalid currency code. Must be 3 uppercase letters. Example: INR", 400));
    }

    if (updates.currency) updates.currency = updates.currency.toUpperCase();

    const org = await Organization.findByIdAndUpdate(
      req.user.orgId,
      { $set: updates },
      { new: true, runValidators: true }
    ).select(
      "name logo_url address timezone currency fiscalYearStart industry country contact_email contact_phone"
    );

    if (!org) {
      return next(new AppError("Organization not found", 404));
    }

    res.json({
      success: true,
      message: "Organization config updated successfully",
      data: org,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/v1/organization/logo (Upload) ─────────────────────
exports.uploadLogo = async (req, res, next) => {
  try {
    if (!req.user.orgId) {
      return next(new AppError("Organization ID not found in user context", 400));
    }

    if (!req.file) {
      return next(new AppError("No file uploaded", 400));
    }

    // File uploaded to Cloudinary via multer middleware
    const logoUrl = req.file.path; // Cloudinary URL

    const org = await Organization.findByIdAndUpdate(
      req.user.orgId,
      { logo_url: logoUrl },
      { new: true }
    ).select("logo_url");

    if (!org) {
      return next(new AppError("Organization not found", 404));
    }

    res.json({
      success: true,
      message: "Logo uploaded successfully",
      data: { logo_url: org.logo_url },
    });
  } catch (err) {
    next(err);
  }
};

exports.removeLogo = async (req, res, next) => {
  try {
    if (!req.user.orgId) {
      return next(new AppError("Organization ID not found in user context", 400));
    }

    const org = await Organization.findByIdAndUpdate(
      req.user.orgId,
      { logo_url: null },
      { new: true }
    ).select("logo_url");

    if (!org) {
      return next(new AppError("Organization not found", 404));
    }

    res.json({
      success: true,
      message: "Organization logo removed successfully",
      data: { logo_url: null },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/v1/organization/hierarchy-tree ─────────────────────
// Returns complete nested hierarchy: Organization → Company → Units → Departments → Employees
exports.getHierarchyTree = async (req, res, next) => {
  try {
    if (!req.user.orgId) {
      return next(new AppError("Organization ID not found in user context", 400));
    }

    const { orgId: requestedOrgId, companyId: requestedCompanyId, unit_id: requestedUnitId } = req.query;
    const orgId = requestedOrgId || req.user.orgId;

    if (String(orgId) !== String(req.user.orgId)) {
      return next(new AppError("Organization access denied", 403));
    }
    if (req.user.companyId && requestedCompanyId && String(requestedCompanyId) !== String(req.user.companyId)) {
      return next(new AppError("Company access denied", 403));
    }
    if (req.user.unitId && requestedUnitId && String(requestedUnitId) !== String(req.user.unitId)) {
      return next(new AppError("Unit access denied", 403));
    }

    const companyId = req.user.companyId || requestedCompanyId;
    const unitId = req.user.unitId || requestedUnitId;

    // Fetch Organization
    const org = await Organization.findById(orgId).select("name logo_url industry country");
    if (!org) {
      return next(new AppError("Organization not found", 404));
    }

    const companyFilter = { org_id: orgId, is_deleted: false };
    if (companyId) companyFilter._id = companyId;

    const companies = await Company.find(companyFilter)
      .select("company_name logo_url company_email company_phone")
      .lean();

    if (companyId && companies.length === 0) {
      return next(new AppError("Company not found", 404));
    }

    const companyNodes = [];

    for (const company of companies) {
      const lobs = await LOB.find({
        company_id: company._id,
        org_id: orgId,
        is_deleted: false
      })
        .select("name description")
        .lean();

      const lobNodes = [];

      for (const lob of lobs) {
        const unitFilter = {
          lob_id: lob._id,
          company_id: company._id,
          org_id: orgId,
          is_deleted: false
        };
        if (unitId) unitFilter._id = unitId;

        const units = await Unit.find(unitFilter)
          .select("name description location logo_url")
          .lean();

        const unitNodes = [];

        for (const unit of units) {
          const departments = await Department.find({
            unit_id: unit._id,
            company_id: company._id,
            org_id: orgId,
            isDeleted: false
          })
            .select("name parentId")
            .lean();

          const employees = await Employee.find({
            unit_id: unit._id,
            company_id: company._id,
            org_id: orgId,
            isDeleted: false,
            status: { $ne: "TERMINATED" }
          })
            .select("name email phone employeeId profilePhoto designationId reportingManagerId status departmentId")
            .populate("designationId", "name")
            .populate("reportingManagerId", "name profilePhoto employeeId")
            .lean();

          const departmentIds = new Set(departments.map(department => String(department._id)));
          const employeesByDepartment = new Map();

          for (const employee of employees) {
            const departmentId = String(employee.departmentId);
            const departmentEmployees = employeesByDepartment.get(departmentId) || [];
            departmentEmployees.push(employee);
            employeesByDepartment.set(departmentId, departmentEmployees);
          }

          const toEmployeeNode = employee => ({
            id: employee._id,
            level: "employee",
            name: employee.name,
            email: employee.email,
            phone: employee.phone,
            employeeId: employee.employeeId,
            profilePhoto: employee.profilePhoto,
            designation: employee.designationId?.name || "Unassigned",
            departmentName: departments.find(department =>
              String(department._id) === String(employee.departmentId)
            )?.name || "Unassigned",
            unitName: unit.name,
            companyName: company.company_name,
            reportingManager: employee.reportingManagerId ? {
              id: employee.reportingManagerId._id,
              name: employee.reportingManagerId.name,
              profilePhoto: employee.reportingManagerId.profilePhoto,
              employeeId: employee.reportingManagerId.employeeId
            } : null,
            status: employee.status
          });

          const buildDepartmentTree = parentId => departments
            .filter(department => {
              const departmentParentId = department.parentId ? String(department.parentId) : null;
              return departmentParentId === parentId;
            })
            .map(department => {
              const nestedDepartments = buildDepartmentTree(String(department._id));
              const directEmployees = (employeesByDepartment.get(String(department._id)) || [])
                .map(toEmployeeNode);
              const nestedEmployeeCount = nestedDepartments.reduce(
                (total, nestedDepartment) => total + nestedDepartment.employeeCount,
                0
              );

              return {
                id: department._id,
                level: department.parentId ? "subDepartment" : "department",
                name: department.name,
                employeeCount: directEmployees.length + nestedEmployeeCount,
                children: [...nestedDepartments, ...directEmployees]
              };
            });

          const rootDepartmentIds = departments
            .filter(department => !department.parentId || !departmentIds.has(String(department.parentId)))
            .map(department => String(department._id));
          const departmentNodes = rootDepartmentIds.flatMap(departmentId => {
            const department = departments.find(item => String(item._id) === departmentId);
            const parentId = department?.parentId ? String(department.parentId) : null;
            return buildDepartmentTree(parentId).filter(node => String(node.id) === departmentId);
          });
          const unassignedEmployees = employees
            .filter(employee => !departmentIds.has(String(employee.departmentId)))
            .map(toEmployeeNode);

          unitNodes.push({
            id: unit._id,
            level: "unit",
            name: unit.name,
            description: unit.description,
            location: unit.location,
            logo: unit.logo_url,
            employeeCount: employees.length,
            children: [...departmentNodes, ...unassignedEmployees]
          });
        }

        lobNodes.push({
          id: lob._id,
          level: "lob",
          name: lob.name,
          description: lob.description,
          employeeCount: unitNodes.reduce((total, unit) => total + unit.employeeCount, 0),
          children: unitNodes
        });
      }

      companyNodes.push({
        id: company._id,
        level: "company",
        name: company.company_name,
        logo: company.logo_url,
        email: company.company_email,
        phone: company.company_phone,
        employeeCount: lobNodes.reduce((total, lob) => total + lob.employeeCount, 0),
        children: lobNodes
      });
    }

    const tree = {
      id: org._id,
      level: "organization",
      name: org.name,
      logo: org.logo_url,
      industry: org.industry,
      country: org.country,
      employeeCount: companyNodes.reduce((total, company) => total + company.employeeCount, 0),
      children: companyNodes
    };

    res.json({
      success: true,
      message: "Organization hierarchy fetched successfully",
      data: tree
    });
  } catch (err) {
    next(err);
  }
};