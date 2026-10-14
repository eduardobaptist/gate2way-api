const express = require('express');
const router = express.Router();
const usuarioController = require('../controllers/usuarioController');
const AutenticarToken = require('../middlewares/auth');
const validarUsuarioCadastro = require('../middlewares/validarCadastroUsuario');


// Cadastrar um usuário
// Validar o corpo antes do controller impede gravacoes de cadastros invalidos.
router.post('/usuarios', AutenticarToken, validarUsuarioCadastro, usuarioController.CadastrarUsuario);

// Responsavel cadastrar usuario
router.post('/cadastrar-usuario', AutenticarToken, usuarioController.ResponsavelCadastrarUsuario);

// Buscar usuario dinamico
router.get('/usuarios/buscar', AutenticarToken, usuarioController.BuscarUsuarioDinamico);

// Atualizar um usuário
router.put('/usuarios/:id', AutenticarToken, usuarioController.AtualizarUsuario);

// Deletar um usuário
router.delete('/usuarios/:id', AutenticarToken, usuarioController.DeletarUsuario);

// Ver um usuário pelo ID
router.get('/usuarios/:id', AutenticarToken, usuarioController.VerUsuario);

// Ver todos os usuários
router.get('/usuarios', AutenticarToken, usuarioController.VerTodosUsuarios);


module.exports = router;
