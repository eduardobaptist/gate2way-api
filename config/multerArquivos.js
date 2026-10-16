const multer = require('multer');
const { createStorage } = require('./uploadStorage');

module.exports = multer({ storage: createStorage('uploads/arquivos/') });
