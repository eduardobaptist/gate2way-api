const Responsavel = require('../models').Responsavel;
const Empresa = require('../models').Empresa;
const Ict = require('../models').Ict;
const Usuario = require('../models').Usuario;
const { Op } = require('sequelize');  

// Criar um novo Responsavel
const CadastrarResponsavel = async (req, res) => {
    // Criar um vinculo diretamente e uma operacao administrativa.
    if (req.user.tipo !== 'admin') {
        return res.status(403).json({ message: 'Apenas administradores podem criar vínculos de responsáveis.' });
    }
    try {
        const responsavel = await Responsavel.create(req.body);
        res.status(201).json(responsavel);
    } catch (error) {
        console.error('Erro ao criar responsável:', error);
        res.status(500).json({ message: `Erro ao criar responsável: ${error.message}` });
    }
};

// Buscar todos os Responsaveis
const BuscarTodosResponsaveis = async (req, res) => {
    try {
        // Estar autenticado nao permite listar responsaveis de outra organizacao.
        const where = {};
        if (req.user.tipo !== 'admin') {
            if (req.user.tipo === 'empresa' && req.user.empresa_id != null) {
                where.empresa_id = req.user.empresa_id;
            } else if (req.user.tipo === 'ict' && req.user.ict_id != null) {
                where.ict_id = req.user.ict_id;
            } else {
                where.usuario_id = req.user.id;
            }
        }
        const responsaveis = await Responsavel.findAll({ where });
        res.status(200).json(responsaveis);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar responsáveis' });
    }
};

// Buscar um Responsavel por ID
const BuscarResponsavelPorId = async (req, res) => {
    try {
        const responsavel = await Responsavel.findByPk(req.params.id);
        if (responsavel) {
            // A consulta por ID deve respeitar o mesmo isolamento da listagem.
            const permitido = req.user.tipo === 'admin' || responsavel.usuario_id === req.user.id ||
                (req.user.tipo === 'empresa' && req.user.empresa_id != null && responsavel.empresa_id === req.user.empresa_id) ||
                (req.user.tipo === 'ict' && req.user.ict_id != null && responsavel.ict_id === req.user.ict_id);
            if (!permitido) {
                return res.status(403).json({ message: 'Acesso negado ao responsável de outra organização.' });
            }
            res.status(200).json(responsavel);
        } else {
            res.status(404).json({ message: 'Responsável não encontrado' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar responsável' });
    }
};

// Atualizar um Responsavel
const AtualizarResponsavel = async (req, res) => {
    try {
        const { cargo, empresa_id, ict_id } = req.body;
        const responsavel = await Responsavel.findByPk(req.params.id);

        if (responsavel) {
            // Um usuario comum nao pode editar o responsavel de outra conta.
            if (req.user.tipo !== 'admin' && responsavel.usuario_id !== req.user.id) {
                return res.status(403).json({ message: 'Você só pode atualizar seu próprio responsável.' });
            }
            // Edicao parcial preserva os vinculos; IDs recebidos precisam ser validos.
            const novaEmpresaId = empresa_id === undefined ? responsavel.empresa_id : empresa_id;
            const novaIctId = ict_id === undefined ? responsavel.ict_id : ict_id;
            for (const valor of [novaEmpresaId, novaIctId]) {
                if (valor != null && (
                    !['number', 'string'].includes(typeof valor) ||
                    !/^[1-9]\d*$/.test(String(valor)) ||
                    !Number.isSafeInteger(Number(valor))
                )) {
                    return res.status(400).json({ message: 'empresa_id e ict_id devem ser inteiros positivos ou null.' });
                }
            }
            // Um responsavel pode estar vinculado a Empresa OU ICT, nunca ambas.
            if (novaEmpresaId != null && novaIctId != null) {
                return res.status(400).json({ message: 'Informe apenas empresa_id ou ict_id.' });
            }
            // Somente admin pode transferir o vinculo; IDs validos nao autorizam a troca.
            const mudouVinculo = (novaEmpresaId == null ? null : Number(novaEmpresaId)) !== responsavel.empresa_id ||
                (novaIctId == null ? null : Number(novaIctId)) !== responsavel.ict_id;
            if (req.user.tipo !== 'admin' && mudouVinculo) {
                return res.status(403).json({ message: 'Apenas administradores podem alterar empresa ou ICT do responsável.' });
            }
            if (novaEmpresaId != null && !await Empresa.findByPk(novaEmpresaId)) {
                return res.status(404).json({ message: 'Empresa não encontrada.' });
            }
            if (novaIctId != null && !await Ict.findByPk(novaIctId)) {
                return res.status(404).json({ message: 'ICT não encontrada.' });
            }

            if (cargo !== undefined) responsavel.cargo = cargo;
            responsavel.empresa_id = novaEmpresaId;
            responsavel.ict_id = novaIctId;
            await responsavel.save();
            res.status(200).json(responsavel);
        } else {
            res.status(404).json({ message: 'Responsável não encontrado' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Erro ao atualizar responsável' });
    }
};

// Deletar um Responsavel
const DeletarResponsavel = async (req, res) => {
    // Impede excluir e recriar um vinculo para contornar a permissao de transferencia.
    if (req.user.tipo !== 'admin') {
        return res.status(403).json({ message: 'Apenas administradores podem excluir vínculos de responsáveis.' });
    }
    try {
        const responsavel = await Responsavel.findByPk(req.params.id);
        if (responsavel) {
            await responsavel.destroy();
            res.status(200).json({ message: 'Responsável deletado com sucesso' });
        } else {
            res.status(404).json({ message: 'Responsável não encontrado' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Erro ao deletar responsável' });
    }
};


const BuscarResponsavelDinamico = async (req, res) => {
    const { q, empresa_id, ict_id } = req.query; // O termo de busca passado na URL e os filtros
  
    try {
      const whereClause = {};
      // O filtro recebido nao pode substituir a organizacao do usuario autenticado.
      if (req.user.tipo !== 'admin') {
        if (req.user.tipo === 'empresa' && req.user.empresa_id != null) {
          if (ict_id || (empresa_id && Number(empresa_id) !== req.user.empresa_id)) {
            return res.status(403).json({ message: 'Acesso negado aos responsáveis de outra organização.' });
          }
          whereClause.empresa_id = req.user.empresa_id;
        } else if (req.user.tipo === 'ict' && req.user.ict_id != null) {
          if (empresa_id || (ict_id && Number(ict_id) !== req.user.ict_id)) {
            return res.status(403).json({ message: 'Acesso negado aos responsáveis de outra organização.' });
          }
          whereClause.ict_id = req.user.ict_id;
        } else {
          if (empresa_id || ict_id) {
            return res.status(403).json({ message: 'Usuário sem vínculo com a organização.' });
          }
          whereClause.usuario_id = req.user.id;
        }
      }
  
      if (q) {
        whereClause[Op.or] = [
          { '$Usuario.nome$': { [Op.like]: `%${q}%` } },    // Filtra pelo nome do usuário
          { '$Usuario.email$': { [Op.like]: `%${q}%` } },   // Filtra pelo email do usuário
          { '$Usuario.telefone$': { [Op.like]: `%${q}%` } } // Filtra pelo telefone do usuário
        ];
      }
  
      if (empresa_id) {
        whereClause.empresa_id = empresa_id;  // Filtra pela empresa associada
      }
  
      if (ict_id) {
        whereClause.ict_id = ict_id;  // Filtra pela ICT associada
      }
  
      const responsaveis = await Responsavel.findAll({
        where: whereClause,
        include: [
          {
            model: Usuario,
            attributes: ['nome', 'email', 'telefone']
          },
          {
            model: Empresa,
            attributes: ['nome'] // Inclui o nome da empresa se estiver associada
          },
          {
            model: Ict,
            attributes: ['nome'] // Inclui o nome da ICT se estiver associada
          }
        ]
      });
  
      if (responsaveis.length === 0) {
        return res.status(404).json({ message: 'Nenhum responsável encontrado.' });
      }
  
      res.status(200).json(responsaveis);
    } catch (error) {
      console.error('Erro ao buscar responsáveis:', error);
      res.status(500).json({ message: 'Erro ao buscar responsáveis.' });
    }
  };
  

module.exports = {
    CadastrarResponsavel,
    BuscarTodosResponsaveis,
    BuscarResponsavelPorId,
    AtualizarResponsavel,
    DeletarResponsavel,
    BuscarResponsavelDinamico
};
