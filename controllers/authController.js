const Usuario = require("../models").Usuario;
const Empresa = require("../models").Empresa;
const Ict = require("../models").Ict;
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Responsavel = require("../models").Responsavel;
require("dotenv").config();

// Login
const Login = async (req, res) => {
  const { email, senha } = req.body;

  try {
    // Verifica se o usuário existe
    const usuario = await Usuario.findOne({ where: { email } });
    if (!usuario) {
      return res.status(404).json({ message: "Usuário não encontrado." });
    }

    // Verifica se a senha está correta
    const senhaCorreta = await bcrypt.compare(senha, usuario.senha);
    if (!senhaCorreta) {
      return res.status(401).json({ message: "Senha incorreta." });
    }

    // Busca as informações de empresa_id ou ict_id no modelo de Responsavel
    const responsavel = await Responsavel.findOne({
      where: { usuario_id: usuario.id },
    });

    if (!responsavel) {
      return res.status(403).json({ message: "Responsável não encontrado." });
    }

    const { empresa_id, ict_id } = responsavel;

    const empresa = await Empresa.findByPk(empresa_id);
    const ict = await Ict.findByPk(ict_id);
    
    // Dados mutaveis ficam fora do JWT; o middleware consulta os vinculos atuais.
    const token = jwt.sign(
      {
        id: usuario.id,
        email: usuario.email,
        tipo: usuario.tipo,
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" } // Opcional: define um tempo de expiração para o token
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    // Retorna as informações no login
    res.status(200).json({
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        tipo: usuario.tipo,
        empresa_id,
        ict_id,
        empresa,
        ict,
      },
    });
  } catch (error) {
    console.error('Falha na operação.');
    res.status(500).json({ message: "Erro ao fazer login." });
  }
};

// Logout
const Logout = async (req, res) => {
  res.cookie("token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    expires: new Date(0),
  });

  res.status(200).end();
};

// Verificar Token
const VerificarToken = async (req, res) => {
  // /auth usa a mesma leitura atualizada do banco que /me.
  res.status(200).json({ message: "Token válido.", usuario: req.user });
};

const GetUser = async (req, res) => {
  // req.user foi carregado do banco pelo middleware, incluindo os relacionamentos.
  res.status(200).json({ usuario: req.user });
};

module.exports = {
  Login,
  Logout,
  VerificarToken,
  GetUser
};
