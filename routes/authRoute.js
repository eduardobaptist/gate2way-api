const express = require('express');
const router = express.Router();
const AutenticarToken = require('../middlewares/auth');
const authController = require('../controllers/authController');

router.post('/login', authController.Login);
router.post('/logout', authController.Logout);
// Validar e consultar o usuario no mesmo middleware evita dados antigos do token.
router.post('/auth', AutenticarToken, authController.VerificarToken);
router.get('/me', AutenticarToken, authController.GetUser);

module.exports = router
