// GET /uploads/:id/download for local storage.
// Moved from uploads.controller.js by BE-11-T03; behaviour unchanged.
const fs = require('fs');
const r2 = require('../../services/r2.service');

const localDownload = async (req, res, next) => {
  try {
    const { key, expires, sig } = req.query;
    const filePath = r2.getLocalDownloadPath(String(key || ''), String(expires || ''), String(sig || ''));
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw Object.assign(new Error('Stored upload not found'), { code: 'ENOENT' });
    } catch (error) {
      if (error.code === 'ENOENT') {
        error.statusCode = 404;
        error.message = 'Stored upload not found';
      }
      throw error;
    }
    return res.download(filePath, (error) => {
      if (!error) return;
      if (error.code === 'ENOENT') {
        error.statusCode = 404;
        error.message = 'Stored upload not found';
      }
      if (res.headersSent) return res.destroy(error);
      return next(error);
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  localDownload,
};
