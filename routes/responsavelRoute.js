const express = require('express');
const router = express.Router();
const responsavelController = require('../controllers/responsavelController');
const AutenticarToken = require('../middlewares/auth');

// Todas as operacoes de responsaveis exigem o cookie de autenticacao.

// Rota para criar um novo Responsavel
router.post('/responsaveis', AutenticarToken, responsavelController.CadastrarResponsavel);

// Rota para buscar todos os Responsaveis
router.get('/responsaveis', AutenticarToken, responsavelController.BuscarTodosResponsaveis);

// Buscar responsavel dinamico 
router.get('/responsaveis/buscar', AutenticarToken, responsavelController.BuscarResponsavelDinamico);

// Rota para buscar um Responsavel por ID
router.get('/responsaveis/:id', AutenticarToken, responsavelController.BuscarResponsavelPorId);

// Rota para atualizar um Responsavel
router.put('/responsaveis/:id', AutenticarToken, responsavelController.AtualizarResponsavel);

// Rota para deletar um Responsavel
router.delete('/responsaveis/:id', AutenticarToken, responsavelController.DeletarResponsavel);

module.exports = router;
