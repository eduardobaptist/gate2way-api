const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport(process.env.EMAIL_TRANSPORT === 'json' ? { jsonTransport: true } : {
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

module.exports = transporter;
