const { body, validationResult } = require('express-validator');

const validarUsuarioCadastro = [
  // Centralizar as regras evita validacoes diferentes no controller e no formulario.
  body('nome')
    .isString().withMessage('O nome deve ser uma string.').bail()
    .custom(value => Boolean(value.trim())).withMessage('O nome é obrigatório.')
    .isLength({ min: 1, max: 255 }).withMessage('O nome deve ter entre 1 e 255 caracteres.'),
    
  body('email')
    .isString().withMessage('O email deve ser uma string.').bail()
    .isEmail().withMessage('O email deve ser válido.')
    .isLength({ max: 255 }).withMessage('O email não deve exceder 255 caracteres.'),

  body('senha')
    .isString().withMessage('A senha deve ser uma string.').bail()
    .isLength({ min: 1, max: 20 }).withMessage('A senha deve ter entre 1 e 20 caracteres.'),

  body('tipo')
    .isString().withMessage('O tipo de usuário deve ser uma string.').bail()
    .isIn(['admin', 'empresa', 'ict']).withMessage('O tipo de usuário deve ser admin, empresa ou ict.')
    .bail()
    .custom((tipo, { req }) => {
      const empresaId = req.body.empresa_id ?? null;
      const ictId = req.body.ict_id ?? null;
      // Cada tipo possui apenas seu vinculo; administradores nao precisam de entidade.
      if (tipo === 'empresa') return empresaId != null && ictId == null;
      if (tipo === 'ict') return ictId != null && empresaId == null;
      return empresaId == null && ictId == null;
    }).withMessage('Informe somente o vínculo correspondente ao tipo de usuário.'),

  body('endereco')
    .optional({ values: 'null' })
    .isString().withMessage('O endereço deve ser uma string.'),

  body('telefone')
    .optional({ values: 'null' })
    .isString().withMessage('O telefone deve ser uma string.'),

  // Cargo, endereco e telefone podem ser null na estrutura atual do banco.
  body('cargo')
    .optional({ values: 'null' })
    .isString().withMessage('O cargo deve ser uma string.'),

  body('empresa_id')
    .optional({ values: 'null' })
    .custom(value => ['number', 'string'].includes(typeof value) &&
      /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)))
    .withMessage('empresa_id deve ser um inteiro positivo.'),

  body('ict_id')
    .optional({ values: 'null' })
    .custom(value => ['number', 'string'].includes(typeof value) &&
      /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)))
    .withMessage('ict_id deve ser um inteiro positivo.'),

  (req, res, next) => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
      return res.status(400).json({ message: erros.array()[0].msg, errors: erros.array() });
    }
    next();
  }
];

module.exports = validarUsuarioCadastro;
