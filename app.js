const express = require("express");
const path = require("path");
const app = express();
const sequelize = require("./config/sequelize");
const projetoRoutes = require("./routes/projetoRoute");
const usuarioRoutes = require("./routes/usuarioRoute");
const empresaRoutes = require("./routes/empresaRoute");
const rotaRoute = require("./routes/rotaRoute");
const programaRoutes = require("./routes/programaRoute");
const responsavelRoutes = require("./routes/responsavelRoute");
const ictRoute = require("./routes/ictRoute");
const impulsoRoute = require("./routes/impulsoRoute");
const ofertaRoutes = require("./routes/ofertaRoute");
const interesseRoutes = require("./routes/interesseRoute");
const parceriaRoutes = require("./routes/parceriaRoute");
const authRoute = require("./routes/authRoute");
const dashboardRoute = require("./routes/dashboard");
const cors = require("cors");
const cookieParser = require('cookie-parser');

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : ['https://www.gate2way.com.br'];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// Middleware para lidar com JSON
app.use(express.json());

app.use(cookieParser());
app.use(require('./middlewares/publicResponse'));

// Middleware para lidar os arquivos uploads
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Rotas
app.use("/api", projetoRoutes);

app.use("/api", usuarioRoutes);

app.use("/api", empresaRoutes);

app.use("/api", rotaRoute);

app.use("/api", programaRoutes);

app.use("/api", responsavelRoutes);

app.use("/api", ictRoute);

app.use("/api", impulsoRoute);

app.use("/api", ofertaRoutes);

app.use("/api", interesseRoutes);

app.use("/api", parceriaRoutes);

app.use("/api", authRoute);

app.use("/api", dashboardRoute);

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  return res.status(status).json({ message: 'Não foi possível concluir a requisição.' });
});

// Inicializacao explicita: nunca altera o esquema. Importar app nao abre servidor.
const start = async () => {
  await sequelize.authenticate();
  const port = process.env.PORT || 3001;
  return app.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Servidor Gate2Way na porta ${port}`);
  });
};
if (require.main === module) {
  start().catch(() => { console.error('Não foi possível iniciar a API.'); process.exitCode = 1; });
}
module.exports = { app, start };
