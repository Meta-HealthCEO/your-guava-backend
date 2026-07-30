const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const authMiddleware = require('../middleware/auth.middleware');
const { apiCache } = require('../middleware/cache.middleware');
const r2 = require('../services/r2.service');
const {
  upload,
  getTransactions,
  getStats,
  getDataStatus,
} = require('../controllers/transactions.controller');

const uploadMaxBytes = () => (
  typeof r2.maxObjectBytes === 'function' ? r2.maxObjectBytes() : 10 * 1024 * 1024
);

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer disk storage config
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${uniqueSuffix}-${safeName}`);
  },
});

const fileFilter = (_req, file, cb) => {
  const allowedExts = ['.csv', '.xlsx'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    const err = new Error('Only CSV and XLSX files are allowed');
    err.statusCode = 400;
    cb(err, false);
  }
};

const multerUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: uploadMaxBytes() },
});

const handleMulterUpload = (req, res, next) => {
  multerUpload.single('file')(req, res, (err) => {
    if (!err) return next();

    if (req.file?.path) {
      fs.rm(req.file.path, { force: true }, () => {});
    }

    const isMulterError = err instanceof multer.MulterError;
    const statusCode = err.statusCode || (isMulterError ? 400 : 500);
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File exceeds ${uploadMaxBytes()} bytes`
        : err.message || 'File upload failed';

    return res.status(statusCode).json({ success: false, message });
  });
};

// All routes are protected
router.use(authMiddleware);

router.post('/upload', handleMulterUpload, upload);
router.get('/status', getDataStatus);
router.get('/stats', apiCache({ ttlMs: 30000, keyPrefix: 'transaction-stats' }), getStats);
router.get('/', getTransactions);

module.exports = router;
