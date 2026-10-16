const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream');

// A abertura exclusiva impede sobrescrita mesmo na improvavel colisao do UUID.
const createStorage = (destination, makeId = randomUUID) => ({
  _handleFile(req, file, cb) {
    fs.mkdir(destination, { recursive: true }, async (mkdirError) => {
      if (mkdirError) return cb(mkdirError);
      const extension = path.extname(file.originalname || '');
      const suffix = /^\.[a-zA-Z0-9]{1,10}$/.test(extension) ? extension : '';
      let fd, filename, filePath;
      try {
        for (let attempt = 0; attempt < 10; attempt++) {
          const id = makeId();
          if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Nome de upload inválido.');
          filename = `${id}${suffix}`;
          filePath = path.join(destination, filename);
          try {
            fd = await new Promise((resolve, reject) => fs.open(filePath, 'wx', 0o600, (error, value) => error ? reject(error) : resolve(value)));
            break;
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }
        if (fd === undefined) throw new Error('Não foi possível reservar um nome de upload.');
      } catch (error) { return cb(error); }
      const output = fs.createWriteStream(filePath, { fd, autoClose: true });
      pipeline(file.stream, output, (error) => {
        if (error) {
          // Somente o arquivo criado por esta requisicao pode ser removido.
          return fs.unlink(filePath, () => cb(error));
        }
        cb(null, { destination, filename, path: filePath, size: output.bytesWritten });
      });
    });
  },
  _removeFile(req, file, cb) {
    const ownPath = file.path;
    delete file.destination; delete file.filename; delete file.path;
    fs.unlink(ownPath, cb);
  },
});
module.exports = { createStorage };
