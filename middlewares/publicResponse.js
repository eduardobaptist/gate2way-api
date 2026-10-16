const { publicData } = require('../services/publicData');
module.exports = (_req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => json(publicData(body));
  next();
};
