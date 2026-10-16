const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const multer = require("multer");

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure storage
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    // Check if it's an Excel/CSV file for bulk import
    const isExcelOrCsv = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv'
    ].includes(file.mimetype)

    if (isExcelOrCsv) {
      return {
        folder: 'hrms/bulk-imports',
        allowed_formats: ['xlsx', 'xls', 'csv'],
        resource_type: 'raw', // Important: use 'raw' for non-image files
        public_id: `${Date.now()}-${file.originalname.replace(/\s/g, '_')}`
      }
    }

    // Check if it's organization logo
    if (req.path.includes('/organization/logo') || req.baseUrl.includes('/organization')) {
      return {
        folder: 'hrms/organizations/logos',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        resource_type: 'image',
        transformation: [{ width: 500, height: 500, crop: 'limit' }], // Resize limit
        public_id: `org-${req.user?.orgId || 'unknown'}-${Date.now()}`
      }
    }

    // Check if it's company logo
    if (req.path.includes('/company/logo') || (req.baseUrl.includes('/company') && file.fieldname === 'logo')) {
      return {
        folder: 'hrms/companies/logos',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
        resource_type: 'image',
        transformation: [{ width: 512, height: 512, crop: 'limit' }],
        public_id: `company-${req.user?.companyId || 'unknown'}-${Date.now()}`
      }
    }

    // Default for employee documents
    return {
      folder: `hrms/employees/${req.params.id}/documents`,
      allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
      resource_type: 'auto',
      public_id: `${Date.now()}-${file.originalname.replace(/\s/g, '_')}`
    }
  }
});

// File filter
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "image/jpeg", 
    "image/png", 
    "image/jpg", 
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
    "application/vnd.ms-excel", // .xls
    "text/csv" // .csv
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only JPG, PNG, PDF, Excel and CSV files are allowed"), false);
  }
};

// Multer upload
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024  // 10MB max for enterprise
  }
});

module.exports = { upload, cloudinary };