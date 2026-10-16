const { Op, QueryTypes } = require("sequelize");
const { sequelize } = require("../models");
const { CAMPOS_CANVAS, CanvasError, revision, updates, verifyPersistence, storageValue } = require("../services/projetoCanvas");
const { projetoDTO } = require("../dtos/projetoDTO");
const Projeto = require("../models").Projeto;
const Programa = require("../models").Programa;
const Oferta = require("../models").Oferta;
const Interesse = require("../models").Interesse;
const Rota = require("../models").Rota;
const Keyword = require("../models").Keyword;
const ProjetoKeyword = require("../models").ProjetoKeyword;
const Empresa = require("../models").Empresa;
const Impulso = require("../models").Impulso;
const Usuario = require("../models").Usuario;
const ProjectsViews = require("../models").ProjectView;
const Ict = require("../models").Ict;
const Responsavel = require("../models").Responsavel;
const fs = require("fs");

const { literal } = require("sequelize");

// Selecionar o projeto
const SelecionarProjeto = async (req, res) => {
  const { id } = req.params;
  const usuarioLogado = req.user;

  try {
    const projeto = await Projeto.findByPk(id, {
      attributes: {
        include: [
          [
            literal(`(
            SELECT COUNT(*)
            FROM interesses AS i
            WHERE i.oferta_id IN (
              SELECT o.id
              FROM ofertas AS o
              WHERE o.projeto_id = Projeto.id
            ) AND i.status = 'pendente'
          )`),
            "total_interesses",
          ],
        ],
      },
      include: [
        {
          model: Programa,
          include: { model: Rota, as: "Rota", include: { model: Empresa } },
        },
        {
          model: Impulso,
          as: "Impulso",
        },
        {
          model: Oferta,
          as: "Oferta",
          include: [
            {
              model: Interesse,
              as: "interesses",
              include: {
                model: Usuario,
                include: {
                  model: Responsavel,
                  include: {
                    model: Ict,
                  },
                },
              },
            },
          ],
        },
      ],
    });

    if (!projeto) {
      return res.status(404).json({ message: "Projeto não encontrado." });
    }

    if (
      usuarioLogado.tipo === "empresa" &&
      projeto.Programa.Rota.empresa_id !== usuarioLogado.empresa_id
    ) {
      return res.status(403).json({ message: "Acesso negado." });
    }

    const projetoData = { ...projeto.toJSON(), canvas_revision: revision(projeto) };
    res.status(200).json(projetoData);

    // criando view pro projeto
    await ProjectsViews.create({
      project_id: projeto.id,
    });
  } catch (error) {
    console.error('Falha na operação.');
    res.status(500).json({ message: "Erro ao buscar o projeto." });
  }
};

// Cadastrar um projeto
const CadastrarProjeto = async (req, res) => {
  const usuarioLogado = req.user;
  let { programa_id, keywords } = req.body;
  usuario_id = req.user.id;

  try {
    const programa = await Programa.findByPk(programa_id, {
      include: { model: Rota, as: "Rota" },
    });

    if (!programa) {
      return res.status(404).json({ message: "Programa não encontrado." });
    }

    if (
      usuarioLogado.tipo !== "admin" &&
      programa.Rota.empresa_id !== usuarioLogado.empresa_id
    ) {
      return res.status(403).json({ message: "Acesso negado." });
    }

    // Cria o projeto e salva o caminho do arquivo, se disponível
    const status = "NÃO PÚBLICADO";
    const arquivoPath = req.file
      ? `/uploads/arquivos/${req.file.filename}`
      : null;
    const novoProjeto = await Projeto.create({
      ...req.body,
      status,
      usuario_id,
      upload: arquivoPath,
    });

    if (typeof keywords === "string") {
      keywords = keywords.split(",").map((kw) => kw.trim());
    }
    if (keywords && keywords.length > 0) {
      for (const keywordNome of keywords) {
        let keyword = await Keyword.findOne({ where: { nome: keywordNome } });
        if (!keyword) {
          keyword = await Keyword.create({ nome: keywordNome });
        }
        await ProjetoKeyword.create({
          projeto_id: novoProjeto.id,
          keyword_id: keyword.id,
        });
      }
    }

    res.status(201).json(novoProjeto);
  } catch (error) {
    console.error('Falha na operação.');

    // Remove o arquivo se houver erro no cadastro
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('Falha na operação.');
      });
    }

    res.status(500).json({ message: "Erro ao criar o projeto." });
  }
};

// Atualizar um projeto
const AtualizarProjeto = async (req, res) => {
  const { id } = req.params;
  const usuarioLogado = req.user;
  let commitPendente = false;
  let resposta;

  try {
    resposta = await sequelize.transaction(async (transaction) => {
      // Row locks require a transactional table. Fail closed without changing schema.
      if (sequelize.getDialect() !== "mysql") {
        throw new CanvasError(503, "CANVAS_STORAGE_UNVERIFIED", "Armazenamento transacional não confirmado.");
      }
      const options = {
        include: { model: Programa, include: { model: Rota, as: "Rota" } },
        transaction,
        lock: transaction.LOCK.UPDATE,
      };
      const projeto = await Projeto.findByPk(id, options);
      if (!projeto) throw new CanvasError(404, "PROJECT_NOT_FOUND", "Projeto não encontrado.");
      // Inspect metadata after acquiring the row/table metadata locks, so a
      // concurrent DDL cannot invalidate the engine check before this write.
      const tables = await sequelize.query(
        "SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table",
        { replacements: { table: "projetos" }, type: QueryTypes.SELECT, transaction }
      );
      if (tables.length !== 1 || tables[0].engine !== "InnoDB") {
        throw new CanvasError(503, "CANVAS_STORAGE_UNVERIFIED", "Armazenamento transacional não confirmado.");
      }
      if (usuarioLogado.tipo !== "admin" &&
          projeto.Programa.Rota.empresa_id !== usuarioLogado.empresa_id) {
        throw new CanvasError(403, "PROJECT_FORBIDDEN", "Acesso negado.");
      }
      if (projeto.status !== "NÃO PÚBLICADO") {
        throw new CanvasError(400, "PROJECT_PUBLISHED", "Não é permitido atualizar projetos publicados.");
      }

      const canvas = updates(projeto, req.body);
      let estiloParaGravar;
      if (Object.keys(canvas).length) {
        // STRING in the model differs from JSON in the migration. Do not risk
        // truncation or conversion in an unverified historical column type.
        const columns = await sequelize.query(
          "SELECT DATA_TYPE AS data_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column",
          { replacements: { table: "projetos", column: "estilo" }, type: QueryTypes.SELECT, transaction }
        );
        if (columns.length !== 1 || columns[0].data_type !== "json") {
          throw new CanvasError(503, "CANVAS_STORAGE_UNVERIFIED", "Tipo de armazenamento do Canvas não confirmado.");
        }
        const raw = await sequelize.query(
          "SELECT CAST(estilo AS CHAR) AS estilo_raw FROM projetos WHERE id = :id FOR UPDATE",
          { replacements: { id: projeto.id }, type: QueryTypes.SELECT, transaction }
        );
        if (raw.length !== 1) {
          throw new CanvasError(409, "CANVAS_STORAGE_MISMATCH", "Não foi possível confirmar o Canvas original.");
        }
        estiloParaGravar = storageValue(raw[0].estilo_raw, projeto.estilo, canvas.estilo);
      }
      const camposParaAtualizar = {};
      const reserved = new Set(["estilo", ...CAMPOS_CANVAS, "canvas_patch", "canvas_revision"]);
      Object.keys(req.body).forEach((campo) => {
        if (!reserved.has(campo) && projeto[campo] !== req.body[campo]) {
          camposParaAtualizar[campo] = req.body[campo];
        }
      });
      Object.assign(camposParaAtualizar, canvas);
      if (estiloParaGravar !== undefined) camposParaAtualizar.estilo = estiloParaGravar;
      if (req.file) camposParaAtualizar.upload = `/uploads/arquivos/${req.file.filename}`;

      if (Object.keys(camposParaAtualizar).length === 0) {
        commitPendente = true;
        return { message: "Nenhuma alteração detectada.", canvas_revision: revision(projeto) };
      }
      const expected = Object.fromEntries(["estilo", ...CAMPOS_CANVAS].map(key => [key, projeto[key]]));
      Object.assign(expected, canvas);
      await projeto.update(camposParaAtualizar, { transaction });
      // Reload in the same transaction: JSON columns may be returned as objects,
      // even though the model declares STRING. Return the persisted representation.
      const persisted = await Projeto.findByPk(id, options);
      verifyPersistence(expected, persisted, Object.keys(canvas).length > 0);
      const result = { ...persisted.toJSON(), canvas_revision: revision(persisted) };
      commitPendente = true;
      return result;
    });
  } catch (error) {
    // Never unlink the old attachment. Retain uploaded files too when a commit
    // may have succeeded; orphan cleanup needs a separate, verified procedure.
    if (commitPendente) {
      return res.status(500).json({
        code: "PROJECT_COMMIT_UNKNOWN",
        message: "Não foi possível confirmar a atualização. Consulte o projeto antes de tentar novamente.",
      });
    }
    if (error instanceof CanvasError) {
      return res.status(error.status).json({ code: error.code, message: error.message });
    }
    // Do not log request bodies, Canvas content or SQL error values.
    console.error('Falha na operação.');
    return res.status(500).json({ message: "Erro ao atualizar o projeto." });
  }
  // Sending a response is outside the transaction catch: do not send twice.
  return res.status(200).json(resposta);
};

// Deletar um projeto
const DeletarProjeto = async (req, res) => {
  const { id } = req.params;
  const usuarioLogado = req.user;

  try {
    const projeto = await Projeto.findByPk(id, {
      include: {
        model: Programa,
        include: {
          model: Rota,
          as: "Rota",
        },
      },
    });

    if (!projeto) {
      return res.status(404).json({ message: "Projeto não encontrado." });
    }

    if (
      usuarioLogado.tipo !== "admin" &&
      projeto.Programa.Rota.empresa_id !== usuarioLogado.empresa_id
    ) {
      return res.status(403).json({
        message:
          "Acesso negado. Você não tem permissão para deletar este projeto.",
      });
    }

    await projeto.destroy();
    res.status(200).json({ message: "Projeto deletado com sucesso." });
  } catch (error) {
    console.error('Falha na operação.');
    res.status(500).json({ message: "Erro ao deletar o projeto." });
  }
};

// Ver Projetos e Filtrar
const VerProjetos = async (req, res) => {
  const usuarioLogado = req.user;
  const { programa_id, rota_id, status, keyword, prioridade } = req.query;

  const whereConditions = {};
  const includeOptions = [];

  if (programa_id) whereConditions.programa_id = programa_id;
  if (status) whereConditions.status = status;
  if (prioridade) whereConditions.prioridade = prioridade;
  if (usuarioLogado.tipo === "ict") whereConditions.status = "PUBLICADO";

  const programaInclude = {
    model: Programa,
    required: true,
    include: [
      {
        model: Rota,
        as: "Rota",
        required: true,
        where: {},
        include: { model: Empresa },
      },
    ],
  };

  if (usuarioLogado.tipo === "empresa") {
    programaInclude.include[0].where.empresa_id = usuarioLogado.empresa_id;
  }

  if (rota_id) {
    programaInclude.include[0].where.id = rota_id;
  }

  if (Object.keys(programaInclude.include[0].where).length === 0) {
    delete programaInclude.include[0].where;
  }

  includeOptions.push(programaInclude);

  if (keyword) {
    includeOptions.push({
      model: Keyword,
      as: "keywords",
      where: { nome: keyword },
      required: true,
    });
  }

  includeOptions.push({
    model: Impulso,
    as: "Impulso",
  });

  try {
    const projetos = await Projeto.findAll({
      where: whereConditions,
      attributes: {
        include: [
          [
            literal(`(
            SELECT COUNT(*)
            FROM interesses AS i
            WHERE i.oferta_id IN (
              SELECT o.id
              FROM ofertas AS o
              WHERE o.projeto_id = Projeto.id
            ) AND i.status = 'pendente'
          )`),
            "total_interesses",
          ],
        ],
      },
      include: includeOptions,
    });

    res.status(200).json(projetos);
  } catch (error) {
    console.error('Falha na operação.');
    res.status(500).json({ message: "Erro ao buscar projetos." });
  }
};

module.exports = {
  SelecionarProjeto,
  CadastrarProjeto,
  AtualizarProjeto,
  DeletarProjeto,
  VerProjetos,
};
