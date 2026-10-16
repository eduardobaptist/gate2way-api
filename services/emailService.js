const transporter = require('../config/emailConfig');

const enviarEmail = async (para, assunto, texto) => {
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: para,
      subject: assunto,
      text: texto
    });
  } catch (error) {
    console.error('Falha na operação.');
  }
};

module.exports = enviarEmail;
