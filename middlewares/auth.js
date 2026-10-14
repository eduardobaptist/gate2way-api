const jwt = require('jsonwebtoken');
const { Usuario, Responsavel, Empresa, Ict } = require('../models');

const AutenticarToken = async (req, res, next) => {
  const token = req.cookies.token

  if (!token) {
    return res.status(401).json({ message: 'Acesso negado, token não fornecido.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ message: 'Token inválido.' });
  }

  try {
    // O JWT identifica o usuario; os vinculos vem do banco para nao ficarem antigos.
    const usuario = await Usuario.findByPk(decoded.id, {
      attributes: { exclude: ['senha'] },
      include: { model: Responsavel, include: [Empresa, Ict] }
    });
    if (!usuario) {
      return res.status(401).json({ message: 'Usuário não encontrado.' });
    }
    const dados = usuario.toJSON();
    const responsavel = dados.Responsavels[0];
    req.user = {
      ...dados,
      empresa_id: responsavel?.empresa_id ?? null,
      ict_id: responsavel?.ict_id ?? null,
      empresa: responsavel?.Empresa ?? null,
      ict: responsavel?.Ict ?? null
    };
    next();
  } catch (err) {
    console.error('Erro ao consultar usuário autenticado:', err);
    res.status(500).json({ message: 'Erro ao consultar usuário autenticado.' });
  }
};

module.exports = AutenticarToken;
