// employee.routes.js
const express = require("express");
const router = express.Router();

const employeeController = require("./employee.controller");
const { authenticate }     = require("../../middlewares/auth.middleware");
const  checkPermission  = require("../../middlewares/permission.middleware");

// const  checkTrial         = require("../../middlewares/checkTrial.middleware");
const  validate  = require("../../middlewares/validate.middleware");  

const { createEmployeeSchema } = require("./employee.validation");
const { updateEmployeeSchema } = require("./employee.validation");
const { activateLoginSchema } = require("./employee.validation");
const { upload } = require("../../config/cloudinary");
const { uploadDocumentSchema } = require("./employee.validation");

const bulkImportController = require("./employeeBulkImport.controller")
const bulkExportController = require("./employeeBulkExport.controller")
const templateController = require("./employeeTemplate.controller")

// ── Self-access OR Permission check middleware ────────────────────────────────
// Enterprise HRMS: Employees can always access their own profile
// Admins/HR need permission to access others
const checkSelfOrPermission = (permission) => async (req, res, next) => {
  const Employee = require("./models/employee.model");

  try {
    // Find current user's employee record
    const emp = await Employee.findOne({
      userId: req.user.userId,
      isDeleted: false
    }).select("_id userId").lean();

    if (!emp) {
      return checkPermission(permission)(req, res, next);
    }

    // Compare employee IDs
    const empIdStr = emp._id.toString();
    const urlIdStr = req.params.id.toString();

    // If viewing/updating own profile → ALLOW (no permission needed)
    if (empIdStr === urlIdStr) {
      return next();
    }

    // If accessing someone else → CHECK PERMISSION (existing logic preserved)
    return checkPermission(permission)(req, res, next);
    
  } catch (error) {
    console.error('[Self-Access Check Error]', error);
    return res.status(500).json({ 
      success: false, 
      message: "Error checking profile access" 
    });
  }
};

router.get("/me", authenticate, employeeController.getMyProfile);

// ── Excel Template Download ──────────────────────────────────────────────────
router.get(
  "/template",
  authenticate,
  checkPermission("employee.read"),
  templateController.downloadTemplate
)

// ── Get Dropdown Data ────────────────────────────────────────────────────────
router.get(
  "/dropdown-data",
  authenticate,
  checkPermission("employee.read"),
  templateController.getDropdownData
)

// ── Bulk Import from Excel ───────────────────────────────────────────────────
router.post(
  "/bulk-import-excel",
  authenticate,
  checkPermission("employee.create"),
  upload.single('file'),
  templateController.bulkImportFromExcel
)

// ── Bulk Import from JSON ────────────────────────────────────────────────────
router.post(
  "/bulk-import",
  authenticate,
  checkPermission("employee.create"),
  bulkImportController.bulkImportEmployees
);

// ── Bulk Export ─────────────────────────────────────────────────────────────
router.get(
  "/export",
  authenticate,
  checkPermission("employee.read"),
  bulkExportController.exportEmployees
);

// E-08 — Update your own profile (phone, address, emergency contact, and profile photo only)
router.put(
  "/me",
  authenticate,
  async (req, res, next) => {
    const Employee = require("./models/employee.model");
    const emp = await Employee.findOne({
      userId:    req.user.userId,
      org_id:    req.user.orgId,
      isDeleted: false,
    }).select("_id").lean();

    if (!emp) return res.status(404).json({ success: false, message: "Employee profile not found" });

    req.params.id = emp._id.toString();
    next();
  },
  employeeController.updateEmployee
);

// E-09 — View and download your own documents
router.get("/me/documents", authenticate, employeeController.getMyDocuments);

// E-10 — Profile completion score
router.get("/me/profile-completion", authenticate, employeeController.getProfileCompletion);

router.post(
  "/",
  authenticate,
  
  checkPermission("employee.create"),
  validate(createEmployeeSchema),
  employeeController.createEmployee
);

router.get(
  "/",
  authenticate,
  
  checkPermission("employee.read"),
  employeeController.getEmployees
);

router.get(
  "/:id",
  authenticate,
  checkSelfOrPermission("employee.read"),
  employeeController.getEmployeeById
);

router.put(
  "/:id",
  authenticate,
  checkSelfOrPermission("employee.update"),
  validate(updateEmployeeSchema),
  employeeController.updateEmployee
);

router.delete(
  "/:id",
  authenticate,

  checkPermission("employee.delete"),
  employeeController.deleteEmployee
);

router.post(
  "/:id/activate-login",
  authenticate,
  
  checkPermission("employee.update"),
  validate(activateLoginSchema),
  employeeController.activateLogin
);


// Profile photo upload - Self-access OR permission
router.post(
  "/:id/upload-profile",
  authenticate,
  checkSelfOrPermission("employee.update"),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No file uploaded"
        });
      }

      const Employee = require("./models/employee.model");
      const employee = await Employee.findByIdAndUpdate(
        req.params.id,
        { profilePhoto: req.file.path },
        { new: true }
      );

      if (!employee) {
        return res.status(404).json({
          success: false,
          message: "Employee not found"
        });
      }

      // ── SYNC: Update User profile photo for unit-level users ────────────
      // Units employees have a userId reference to User collection
      if (employee.userId) {
        const User = require("../auth/models/user.model");
        const Role = require("../role/role.model");
        
        const user = await User.findById(employee.userId).select("roleId profilePhoto");
        if (user) {
          const role = await Role.findById(user.roleId).select("slug level").lean();
          
          // Only sync for unit-level users/employees
          if (role?.level === 'unit' || role?.slug === 'employee') {
            await User.findByIdAndUpdate(
              employee.userId,
              { profilePhoto: req.file.path },
              { new: true }
            );
            console.log(`✅ Synced profile photo to User record for employee ${employee.email}`);
          }
        }
      }

      return res.status(200).json({
        success: true,
        message: "Profile photo uploaded successfully",
        data: { profilePhoto: employee.profilePhoto }
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/:id/documents",
  authenticate,
  
  checkPermission("employee.update"),
  upload.single("file"),          // ✅ file upload
  employeeController.uploadDocument
);

router.get(
  "/:id/documents",
  authenticate,
  checkSelfOrPermission("employee.read"),
  employeeController.getDocuments
);

router.delete(
  "/:id/documents/:docId",
  authenticate,
  checkSelfOrPermission("employee.update"),
  employeeController.deleteDocument
);

router.patch(
  "/:id/documents/:docId/verify",
  authenticate,
  
  checkPermission("employee.update"),
  employeeController.verifyDocument
);

router.patch("/:id/status",   authenticate,
  
  checkPermission("employee.update"),
  employeeController.changeStatus
);

router.get("/me/documents/:docId/download", authenticate, employeeController.downloadMyDocument);

// ── Employee Timeline ────────────────────────────────────────────────────────
// GET /api/v1/employees/:id/timeline - Career progression timeline
const timelineRoutes = require("./employeeTimeline.routes");
router.use("/:id/timeline", timelineRoutes);

module.exports = router;