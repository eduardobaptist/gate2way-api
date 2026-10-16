// Serializa respostas sem credenciais, inclusive em associacoes aninhadas.
const privateKeys = new Set(['senha', 'password', 'password_hash', 'passwordHash', 'senhaHash', 'token', 'refreshToken']);
const publicData = (value) => {
  if (value == null || typeof value !== 'object') return value;
  if (typeof value.toJSON === 'function') return publicData(value.toJSON());
  if (Array.isArray(value)) return value.map(publicData);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !privateKeys.has(key))
    .map(([key, item]) => [key, publicData(item)]));
};
module.exports = { publicData };
