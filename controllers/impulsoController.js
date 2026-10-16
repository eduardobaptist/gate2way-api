const { Impulso, Projeto, sequelize } = require("../models");
const { Op, QueryTypes } = require('sequelize');

// Criar um novo Impulso
const CadastrarImpulso = async (req, res) => {
  try {
    const { tipo, descricao, valor, data_inicio, data_fim } = req.body;
    const empresa_id = req.user.empresa_id;

    const novoImpulso = await Impulso.create({
      tipo,
      descricao,
      valor,
      data_inicio,
      data_fim,
      empresa_id,
    });

    res.status(201).json(novoImpulso);
  } catch (error) {
    console.error("Erro ao criar Impulso:", error);
    res.status(500).json({ message: `Erro ao criar Impulso: ${error.message}` });
  }
};

// Buscar todos os Impulsos
const BuscarTodosImpulsos = async (req, res) => {
  const { empresa_id } = req.user;
  try {
    const whereClause = empresa_id != null
      ? {
        [Op.or]: [
          { empresa_id: empresa_id },
          { empresa_id: null }
        ]
      } : null

    const impulsos = await Impulso.findAll({
      where: whereClause, order: [
        // impulsos padrão primeio
        ['empresa_id', 'ASC']
      ]
    });
    res.status(200).json(impulsos);
  } catch (error) {
    res.status(500).json({ message: "Erro ao buscar Impulsos" });
  }
};

// Selecionar um Impulso
const BuscarImpulsoPorId = async (req, res) => {
  try {
    const impulso = await Impulso.findByPk(req.params.id);
    if (impulso) {
      res.status(200).json(impulso);
    } else {
      res.status(404).json({ message: "Impulso não encontrado" });
    }
  } catch (error) {
    res.status(500).json({ message: "Erro ao buscar Impulso" });
  }
};

// Atualizar um Impulso
const AtualizarImpulso = async (req, res) => {
  try {
    const { tipo, descricao, valor, data_inicio, data_fim } = req.body;
    const impulso = await Impulso.findByPk(req.params.id);
    const usuario = req.user;

    if (impulso.empresa_id === usuario?.empresa_id || usuario.tipo === 'admin') {
      impulso.tipo = ''; //temporário
      impulso.descricao = descricao;
      impulso.valor = valor;
      impulso.data_inicio = data_inicio;
      impulso.data_fim = data_fim;
      impulso.empresa_id = usuario.empresa_id;

      await impulso.save();
      res.status(200).json(impulso);
    } else {
      res.status(404).json({ message: "Impulso não encontrado" });
    }
  } catch (error) {
    res.status(500).json({ message: "Erro ao atualizar Impulso" });
  }
};

// Deletar um Impulso
const DeletarImpulso = async (req, res) => {
  const id = req.params?.id;
  const impulsoId = typeof id === 'string' && /^[1-9][0-9]{0,9}$/.test(id) ? Number(id) : NaN;
  // A migration declara INTEGER com sinal. A comparacao canonica tambem rejeita espacos e quebras de linha.
  if (!Number.isSafeInteger(impulsoId) || impulsoId > 2147483647 || String(impulsoId) !== id) {
    return res.status(400).json({ message: "ID do impulso inválido." });
  }

  let resultado;
  let exclusaoPendenteDeCommit = false;
  try {
    resultado = await sequelize.transaction(async (transaction) => {
      // O bloqueio do pai impede novos vinculos enquanto a FK e os dependentes sao verificados.
      const impulso = await Impulso.findByPk(impulsoId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!impulso) {
        return { status: 404, message: "Impulso não encontrado" };
      }

      const empresaUsuarioId = req.user?.empresa_id;
      if (
        !Number.isSafeInteger(empresaUsuarioId) || empresaUsuarioId <= 0 ||
        impulso.empresa_id !== empresaUsuarioId
      ) {
        // Mantem a resposta existente de negacao; null nunca representa propriedade.
        return { status: 404, message: "Você não tem permissão para deletar esse impulso" };
      }

      // Leitura com bloqueio consulta o estado atual, inclusive apos esperar outra transaction.
      const projeto = await Projeto.findOne({
        where: { impulso_id: impulso.id },
        attributes: ['id'],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (projeto) {
        return { status: 409, message: "Não é possível excluir um impulso com projetos vinculados." };
      }

      // Sem InnoDB e FK simples ativa, o bloqueio do pai nao garante protecao concorrente.
      // As leituras acima mantem os metadados das duas tabelas bloqueados ate o commit.
      const protecao = await sequelize.query(`
        SELECT 1 AS protegida
        FROM information_schema.KEY_COLUMN_USAGE AS fk
        JOIN information_schema.TABLES AS filha
          ON filha.TABLE_SCHEMA = fk.TABLE_SCHEMA AND filha.TABLE_NAME = fk.TABLE_NAME
        JOIN information_schema.TABLES AS pai
          ON pai.TABLE_SCHEMA = fk.REFERENCED_TABLE_SCHEMA
          AND pai.TABLE_NAME = fk.REFERENCED_TABLE_NAME
        WHERE fk.TABLE_SCHEMA = DATABASE()
          AND fk.TABLE_NAME = 'projetos' AND fk.COLUMN_NAME = 'impulso_id'
          AND fk.REFERENCED_TABLE_SCHEMA = DATABASE()
          AND fk.REFERENCED_TABLE_NAME = 'impulsos' AND fk.REFERENCED_COLUMN_NAME = 'id'
          AND filha.ENGINE = 'InnoDB' AND pai.ENGINE = 'InnoDB'
          AND @@SESSION.foreign_key_checks = 1
          AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE AS coluna
            WHERE coluna.CONSTRAINT_SCHEMA = fk.CONSTRAINT_SCHEMA
              AND coluna.TABLE_SCHEMA = fk.TABLE_SCHEMA AND coluna.TABLE_NAME = fk.TABLE_NAME
              AND coluna.CONSTRAINT_NAME = fk.CONSTRAINT_NAME) = 1
        LIMIT 1
      `, { type: QueryTypes.SELECT, transaction });
      if (protecao.length === 0) {
        return { status: 503, message: "Exclusão temporariamente bloqueada por segurança." };
      }

      await impulso.destroy({ transaction });
      exclusaoPendenteDeCommit = true;
      return { status: 200, message: "Impulso deletado com sucesso" };
    });
  } catch (error) {
    // Falhas do callback acionam rollback gerenciado. Falha na confirmacao do COMMIT nao prova rollback.
    if (exclusaoPendenteDeCommit) {
      return res.status(500).json({
        message: "Não foi possível confirmar o resultado da exclusão. Verifique o impulso antes de tentar novamente.",
      });
    }
    return res.status(500).json({ message: "Erro ao deletar Impulso" });
  }

  // Responder somente depois do commit; erros ao enviar a resposta nao devem gerar uma segunda resposta.
  return res.status(resultado.status).json({ message: resultado.message });
};

module.exports = {
  CadastrarImpulso,
  BuscarTodosImpulsos,
  BuscarImpulsoPorId,
  AtualizarImpulso,
  DeletarImpulso,
};
