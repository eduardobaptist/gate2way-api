const { publicData } = require('../services/publicData');
const Usuario = require('../models').Usuario;
const Responsavel = require('../models').Responsavel;
const Empresa = require('../models').Empresa;
const Ict = require('../models').Ict;
const sequelize = require('../models').sequelize;
const enviarEmail = require('../services/emailService');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');

// Trocar senha primeiro acesso:
const TrocarSenhaPrimeiroAcesso = async (req, res) => {
  const usuarioLogado = req.user;
  const { novaSenha } = req.body;

  try {
    // Buscar o usuário no banco de dados
    const usuario = await Usuario.findByPk(usuarioLogado.id);

    if (!usuario) {
      return res.status(404).json({ message: 'Usuário não encontrado.' });
    }

    // Verifica se é o primeiro acesso e atualiza a senha
    if (usuario.primeiro_acesso) {
      const novaSenhaHash = await bcrypt.hash(novaSenha, 10);

      usuario.senha = novaSenhaHash;
      usuario.primeiro_acesso = false; // Atualiza o campo para false após a troca de senha
      await usuario.save();

      res.status(200).json({ message: 'Senha atualizada com sucesso. Primeiro acesso concluído.' });
    } else {
      res.status(403).json({ message: 'A troca de senha inicial já foi realizada.' });
    }
  } catch (error) {
    console.error('Falha na operação.');
    res.status(500).json({ message: 'Erro ao trocar senha.' });
  }
};


// Responsavel cadastra outro responsavel
const ResponsavelCadastrarUsuario = async (req, res) => {
  const { nome, email, senha, endereco, telefone, cargo } = req.body;
  const usuarioLogado = req.user;


  try {
    const responsavelLogado = await Responsavel.findOne({
      where: { usuario_id: usuarioLogado.id }
    });


    if (!responsavelLogado) {
      return res.status(403).json({ message: 'Usuário não tem permissão para cadastrar.' });
    }
    let empresa_id = null;
    let ict_id = null;

    if (usuarioLogado.tipo === 'empresa') {
      empresa_id = responsavelLogado.empresa_id;
      if (!empresa_id) {
        return res.status(403).json({ message: 'Empresa não associada ao responsável logado.' });
      }
    } else if (usuarioLogado.tipo === 'ict') {
      ict_id = responsavelLogado.ict_id;
      if (!ict_id) {
        return res.status(403).json({ message: 'ICT não associada ao responsável logado.' });
      }
    } else {
      return res.status(400).json({ message: 'Tipo de usuário inválido.' });
    }

    const senhaHash = await bcrypt.hash(senha, 10);
    // O cadastro feito por responsavel tambem precisa desfazer gravacoes parciais.
    const novoUsuario = await sequelize.transaction(async (transaction) => {
      const usuario = await Usuario.create({
        nome,
        email,
        senha: senhaHash,
        tipo: usuarioLogado.tipo, // O tipo é forçado a ser igual ao do responsável
        primeiro_acesso: true,
        endereco,
        telefone,
      }, { transaction });

      await Responsavel.create({
        usuario_id: usuario.id,
        cargo,
        empresa_id,
        ict_id
      }, { transaction });

      return usuario;
    });

    await enviarEmail(
      email,
      'Bem-vindo à plataforma Gate2Way',
      `Olá ${nome},\n\nVocê foi cadastrado na plataforma Gate2Way.\n\nDados de acesso:\nEmail: ${email}\nSenha: ${senha}\n\nPor segurança, recomendamos que altere sua senha após o primeiro acesso.\n\nAtenciosamente,\nEquipe Gate2Way`
    );

    res.status(201).json({
      message: 'Usuário e responsável cadastrados com sucesso!',
      usuario: publicData(novoUsuario)
    });
  } catch (error) {
    console.error('Falha na operação.'); // Log do erro
    res.status(500).json({ message: 'Erro ao cadastrar o usuário e responsável.' });
  }
};

// ADMIN Cadastrar um usuário no sistema
const CadastrarUsuario = async (req, res) => {
  const { nome, email, senha, tipo, endereco, telefone, cargo, empresa_id, ict_id } = req.body;
  const usuarioLogado = req.user;

  // Verifica se o usuário logado é admin
  if (usuarioLogado.tipo !== 'admin') {
    return res.status(403).json({ message: 'Acesso negado. Apenas administradores podem cadastrar usuários.' });
  }

  try {
    // O middleware valida os campos; conferir a entidade antes de criar evita orfaos.
    const responsavelEmpresaId = empresa_id ?? null;
    const responsavelIctId = ict_id ?? null;
    if (responsavelEmpresaId != null && !await Empresa.findByPk(responsavelEmpresaId)) {
      return res.status(404).json({ message: 'Empresa não encontrada.' });
    }
    if (responsavelIctId != null && !await Ict.findByPk(responsavelIctId)) {
      return res.status(404).json({ message: 'ICT não encontrada.' });
    }

    const senhaHash = await bcrypt.hash(senha, 10);
    // A transaction desfaz o usuario se a criacao do responsavel falhar.
    const novoUsuario = await sequelize.transaction(async (transaction) => {
      const usuario = await Usuario.create({
        nome,
        email,
        senha: senhaHash,
        tipo,
        primeiro_acesso: true,
        endereco,
        telefone,
      }, { transaction });

      await Responsavel.create({
        usuario_id: usuario.id,
        cargo,
        empresa_id: responsavelEmpresaId,
        ict_id: responsavelIctId,
      }, { transaction });

      return usuario;
    });

    await enviarEmail(
      email,
      'Bem-vindo à plataforma Gate2Way',
      `Olá ${nome},\n\nVocê foi cadastrado na plataforma Gate2Way.\n\nDados de acesso:\nEmail: ${email}\nSenha: ${senha}\n\nPor segurança, recomendamos que altere sua senha após o primeiro acesso.\n\nAtenciosamente,\nEquipe Gate2Way`
    );

    res.status(201).json({
      message: 'Usuário e responsável cadastrados com sucesso!',
      usuario: publicData(novoUsuario)
    });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') { //erro de unique constraint não respeitado
      var field = error.errors[0].path;
      
      if (field === 'email') {
        return res.status(409).json({ 
          message: 'Este e-mail já é usado por outro usuário' 
        });
      } 
    }

    console.error('Falha na operação.');
    res.status(500).json({ message: 'Erro ao cadastrar o usuário e responsável.' });
  }
};

// ADMIN E USUARIO Atualizar um usuário existente
const AtualizarUsuario = async (req, res) => {
  const { id } = req.params;
  const usuarioLogado = req.user;
  const { cargo } = req.body;

  try {
    const resultado = await sequelize.transaction(async (transaction) => {
      const usuario = await Usuario.findByPk(id, {
        transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!usuario) return { status: 404, body: { message: 'Usuário não encontrado.' } };
      if (usuarioLogado.tipo !== 'admin' && usuario.id !== usuarioLogado.id) {
        return { status: 403, body: { message: 'Acesso negado. Você só pode atualizar sua própria conta.' } };
      }
      if (req.body.senha != null && typeof req.body.senha !== 'string') {
        return { status: 400, body: { message: 'A senha deve ser uma string.' } };
      }
      const responsavel = await Responsavel.findOne({
        where: { usuario_id: id }, transaction, lock: transaction.LOCK.UPDATE,
      });
      const changes = {};
      for (const campo of ['nome', 'email', 'senha', 'telefone', 'endereco']) {
        if (campo === 'senha' && (req.body.senha == null || req.body.senha === '')) continue;
        if (req.body[campo] !== undefined && usuario[campo] !== req.body[campo]) {
          changes[campo] = campo === 'senha' ? await bcrypt.hash(req.body.senha, 10) : req.body[campo];
        }
      }
      if (Object.keys(changes).length) await usuario.update(changes, { transaction });
      if (responsavel && cargo !== undefined && responsavel.cargo !== cargo) {
        await responsavel.update({ cargo }, { transaction });
      }
      return { status: 200, body: publicData({ message: 'Usuário atualizado com sucesso.', usuario, responsavel }) };
    });
    return res.status(resultado.status).json(resultado.body);
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError' && error.errors?.[0]?.path === 'email') {
      return res.status(409).json({ message: 'Este e-mail já é usado por outro usuário' });
    }
    // A perda da confirmacao de COMMIT nao comprova rollback; nao repetir automaticamente.
    return res.status(500).json({ message: 'Não foi possível confirmar a atualização. Recarregue o usuário antes de tentar novamente.' });
  }
};


// ADMIN Deletar um usuário
const DeletarUsuario = async (req, res) => {
  const { id } = req.params;

  // Autenticacao sozinha nao autoriza exclusao; apenas o perfil admin pode excluir.
  if (req.user.tipo !== 'admin') {
    return res.status(403).json({ message: 'Acesso negado. Apenas administradores podem excluir usuários.' });
  }

  try {
    const usuario = await Usuario.findByPk(id);
    if (!usuario) {
      return res.status(404).json({ message: 'Usuário não encontrado.' });
    }

    await usuario.destroy();
    res.status(200).json({ message: 'Usuário deletado com sucesso.' });
  } catch (error) {
    res.status(500).json({ message: 'Erro ao deletar o usuário.' });
  }
};

// ADMIN Ver um usuário pelo ID
const VerUsuario = async (req, res) => {
  const { id } = req.params;

  try {
    const usuario = await Usuario.findByPk(id, {
      include: {
        model: Responsavel, as: 'Responsavels', include: [
          { model: Empresa, required: false },
          { model: Ict, required: false }
        ]
      }
    });

    // Verificar a ausencia antes de acessar usuario.id evita TypeError e erro 500.
    if (!usuario) {
      return res.status(404).json({ message: 'Usuário não encontrado' });
    }

    if (req.user.tipo !== "admin" && usuario.id !== req.user.id) {
      return res.status(403).json({ message: 'Acesso negado.' });
    }

    res.status(200).json(publicData(usuario));
  } catch (error) {
    res.status(500).json({ message: 'Erro ao buscar o usuário.' });
  }
};

// ADMIN Ver todos os usuários
const VerTodosUsuarios = async (req, res) => {
  try {
    const usuarios = await Usuario.findAll({
      include:
      {
        model: Responsavel, as: 'Responsavels', include: [
          { model: Empresa, required: false },
          { model: Ict, required: false }
        ]
      }
    });

    if (req.user.tipo !== 'admin') {
      return res.status(403).json({ message: 'Acesso negado.' });
    }

    res.status(200).json(publicData(usuarios));
  } catch (error) {
    res.status(500).json({ message: 'Erro ao buscar os usuários.' });
  }
};

const BuscarUsuarioDinamico = async (req, res) => {
  const { q } = req.query; // O termo de busca passado na URL

  if (req.user.tipo !== 'admin') {
    return res.status(403).json({ message: 'Acesso negado.' });
  }

  if (!q) {
    return res.status(400).json({ message: 'Por favor, forneça um termo de busca.' });
  }

  try {
    const usuarios = await Usuario.findAll({
      where: {
        [Op.or]: [
          { nome: { [Op.like]: `%${q}%` } },
          { email: { [Op.like]: `%${q}%` } },
          { telefone: { [Op.like]: `%${q}%` } },
          { tipo: { [Op.like]: `%${q}%` } }
        ]
      }
    });

    if (usuarios.length === 0) {
      return res.status(404).json({ message: 'Nenhum usuário encontrado.' });
    }

    res.status(200).json(publicData(usuarios));
  } catch (error) {
    console.error('Falha na operação.');
    res.status(500).json({ message: 'Erro ao buscar usuários' });
  }
};

module.exports = {
  CadastrarUsuario,
  AtualizarUsuario,
  DeletarUsuario,
  VerUsuario,
  VerTodosUsuarios,
  BuscarUsuarioDinamico,
  ResponsavelCadastrarUsuario,
  TrocarSenhaPrimeiroAcesso
};
