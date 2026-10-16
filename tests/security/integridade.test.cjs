const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { publicData } = require('../../services/publicData');
const { createStorage } = require('../../config/uploadStorage');
const root = path.resolve(__dirname, '../..');
function load(file, mocks) {
  const sandbox = { module: { exports: {} }, console: { log() { assert.fail('Log de dados'); }, error() {} }, require(name) {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    throw Error('Importacao nao autorizada: ' + name);
  }};
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
  return sandbox.module.exports;
}
async function response(fn, req, events = []) {
  const replies = [];
  await fn(req, { status(code) { this.code = code; return this; }, json(body) { replies.push({ status: this.code, body }); events.push('response'); } });
  assert.equal(replies.length, 1);
  return replies[0];
}
function fixture({ missing = false, failure = null, owner = 10 } = {}) {
  const events = [];
  const user = { id: 1, nome: 'Anterior', senha: 'hash-sintetico' };
  const responsavel = { cargo: 'Anterior' };
  const impulso = { id: 1, empresa_id: owner, tipo: 'Historico', descricao: 'Anterior', valor: 42 };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  function options(o) { assert.equal(o.transaction, transaction); }
  const before = () => ({ user: { ...user }, responsavel: { ...responsavel }, impulso: { ...impulso } });
  const models = {
    Usuario: { findByPk: async (_, o) => { options(o); assert.equal(o.lock, 'UPDATE'); return missing ? null : user; } },
    Responsavel: { findOne: async (o) => { options(o); return responsavel; } },
    Impulso: { findByPk: async (_, o) => { options(o); return missing ? null : impulso; } },
    sequelize: { transaction: async (fn) => {
      const original = before(); events.push('begin');
      try {
        const out = await fn(transaction);
        if (failure === 'commit') throw Error('Confirmacao perdida');
        events.push('commit'); return out;
      } catch (error) {
        if (failure !== 'commit') {
          Object.assign(user, original.user); Object.assign(responsavel, original.responsavel); Object.assign(impulso, original.impulso);
          events.push('rollback');
        }
        throw error;
      }
    } },
  };
  user.update = async (changes, o) => { options(o); events.push('user-write'); Object.assign(user, changes); if (failure === 'user') throw Error('Falha sintetica'); };
  responsavel.update = async (changes, o) => { options(o); if (failure === 'responsavel') throw Error('Falha sintetica'); Object.assign(responsavel, changes); };
  impulso.save = async (o) => { options(o); events.push('impulso-write'); if (failure === 'impulso') throw Error('Falha sintetica'); };
  const mocks = { '../models': models, sequelize: { Op: {}, QueryTypes: {} }, bcryptjs: { hash: async (value) => 'mock:' + value }, '../services/emailService': () => assert.fail('Email real proibido'), '../services/publicData': { publicData } };
  return { user, responsavel, impulso, events, usuario: load('controllers/usuarioController.js', mocks), impulsos: load('controllers/impulsoController.js', mocks) };
}
for (const senha of [undefined, null, '', 'nova', '  espacos  ', false, 1, [], {}]) {
  test('Edicao atomica e senha ' + JSON.stringify(senha), async () => {
    const f = fixture();
    const result = await response(f.usuario.AtualizarUsuario, { params: { id: '1' }, user: { id: 1, tipo: 'empresa' }, body: { nome: 'Editado', cargo: 'Editado', senha } }, f.events);
    const invalid = senha != null && typeof senha !== 'string';
    assert.equal(result.status, invalid ? 400 : 200);
    assert.equal(f.user.nome, invalid ? 'Anterior' : 'Editado');
    assert.equal(f.responsavel.cargo, invalid ? 'Anterior' : 'Editado');
    assert.equal(f.user.senha, invalid || senha == null || senha === '' ? 'hash-sintetico' : 'mock:' + senha);
    assert.ok(f.events.indexOf('commit') < f.events.indexOf('response'));
    if (!invalid) assert.equal(Object.hasOwn(result.body.usuario, 'senha'), false);
  });
}
for (const failure of ['user', 'responsavel', 'commit']) {
  test('Falha de edicao ' + failure, async () => {
    const f = fixture({ failure });
    const result = await response(f.usuario.AtualizarUsuario, { params: { id: '1' }, user: { id: 1, tipo: 'empresa' }, body: { nome: 'Novo', cargo: 'Novo' } });
    assert.equal(result.status, 500);
    if (failure !== 'commit') { assert.equal(f.user.nome, 'Anterior'); assert.equal(f.responsavel.cargo, 'Anterior'); assert.ok(f.events.includes('rollback')); }
    else { assert.ok(!f.events.includes('rollback')); assert.match(result.body.message, /confirmar/); }
  });
}
for (const [missing, userId, status] of [[true, 1, 404], [false, 99, 403]]) {
  test('Permissoes de usuario ' + status, async () => {
    const f = fixture({ missing });
    assert.equal((await response(f.usuario.AtualizarUsuario, { params: { id: '1' }, user: { id: userId, tipo: 'empresa' }, body: { nome: 'Novo' } })).status, status);
    assert.ok(!f.events.includes('user-write'));
  });
}
for (const [owner, empresa, tipo, status] of [[null, null, 'ict', 403], [null, 10, 'admin', 403], [10, null, 'ict', 403], [10, 20, 'empresa', 403], [10, 10, 'empresa', 200], [10, null, 'admin', 200]]) {
  test(`Impulso owner=${owner} empresa=${empresa} perfil=${tipo}`, async () => {
    const f = fixture({ owner });
    const result = await response(f.impulsos.AtualizarImpulso, { params: { id: '1' }, user: { tipo, empresa_id: empresa }, body: { descricao: 'Nova', empresa_id: 99 } }, f.events);
    assert.equal(result.status, status);
    assert.equal(f.impulso.empresa_id, owner); assert.equal(f.impulso.tipo, 'Historico'); assert.equal(f.impulso.valor, 42);
    assert.equal(f.events.includes('impulso-write'), status === 200);
  });
}
for (const id of ['0', '-1', '1abc', '01', '1.0', '1e1', ' 1', '2147483648', '1\n']) {
  test('ID de atualizacao rejeitado sem consulta: ' + JSON.stringify(id), async () => {
    const f = fixture();
    assert.equal((await response(f.impulsos.AtualizarImpulso, { params: { id }, user: {}, body: {} })).status, 400);
    assert.deepEqual(f.events, []);
  });
}
test('Serializacao remove credenciais de associacoes sem alterar instancias', () => {
  const original = { nome: 'Sintetico', senha: 'hash-sintetico', Responsavels: [{ Usuario: { senha: 'outro', id: 2 } }], createdAt: new Date('2026-01-01') };
  const out = publicData(original);
  assert.equal(out.senha, undefined); assert.equal(out.Responsavels[0].Usuario.senha, undefined);
  assert.equal(out.Responsavels[0].Usuario.id, 2); assert.equal(out.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(original.senha, 'hash-sintetico');
});
const upload = (storage, content) => new Promise((resolve, reject) => storage._handleFile({}, { originalname: 'sintetico.txt', stream: Readable.from(content) }, (error, file) => error ? reject(error) : resolve(file)));
test('Colisao de nome nao sobrescreve arquivo existente', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2way-upload-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'colisao.txt'), 'Original sintetico');
    let n = 0; const storage = createStorage(dir, () => ++n === 1 ? 'colisao' : 'novo');
    const file = await upload(storage, 'Novo sintetico');
    assert.equal(fs.readFileSync(path.join(dir, 'colisao.txt'), 'utf8'), 'Original sintetico');
    assert.equal(fs.readFileSync(file.path, 'utf8'), 'Novo sintetico');
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('Uploads concorrentes preservam todos os conteudos sinteticos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2way-upload-test-'));
  try {
    const files = await Promise.all(Array.from({ length: 20 }, (_, i) => upload(createStorage(dir), 'Sintetico-' + i)));
    assert.equal(new Set(files.map(f => f.path)).size, 20);
    files.forEach((f, i) => assert.equal(fs.readFileSync(f.path, 'utf8'), 'Sintetico-' + i));
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('Importar config Sequelize nao conecta nem sincroniza', () => {
  const sequelize = new Proxy({}, { get() { assert.fail('Acesso automatico ao banco'); } });
  assert.equal(load('config/sequelize.js', { '../models': { sequelize } }), sequelize);
});
test('Colisoes repetidas falham sem alterar arquivo preexistente', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2way-upload-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'mesmo.txt'), 'Original sintetico');
    await assert.rejects(upload(createStorage(dir, () => 'mesmo'), 'Nao gravar'), /reservar/);
    assert.equal(fs.readFileSync(path.join(dir, 'mesmo.txt'), 'utf8'), 'Original sintetico');
    assert.equal(fs.readdirSync(dir).length, 1);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('Falha de stream remove somente o upload criado pela propria requisicao', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2way-upload-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'antigo.txt'), 'Original sintetico');
    const stream = new Readable({ read() { this.destroy(new Error('Falha sintetica')); } });
    await assert.rejects(new Promise((resolve, reject) => createStorage(dir)._handleFile({}, { originalname: 'novo.txt', stream }, (e, file) => e ? reject(e) : resolve(file))));
    assert.deepEqual(fs.readdirSync(dir), ['antigo.txt']);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
for (const [model, file, handler, key] of [['Empresa', 'empresaController.js', 'AtualizarEmpresa', 'empresa'], ['Ict', 'ictController.js', 'AtualizarIct', 'ict']]) {
  for (const fail of [false, true]) test(`Atualizacao ${model}, falha=${fail}, preserva arquivos existentes`, async () => {
    const entity = { id: 1, foto_perfil: '/uploads/fotos/antigo-sintetico.png', update: async () => { if (fail) throw Error('Falha sintetica'); } };
    const models = { Usuario: { findByPk: async () => ({ tipo: 'admin' }) }, [model]: { findByPk: async () => entity } };
    const api = load('controllers/' + file, { '../models': models, '../config/multerFotoPerfil': {}, fs: { unlink: () => assert.fail('Nao remover anexos') }, path });
    const r = await response(api[handler], { params: { id: '1' }, user: { id: 1 }, body: { nome: 'Sintetico' }, file: { filename: 'novo-sintetico.png', path: 'uploads/fotos/novo-sintetico.png' } });
    assert.equal(r.status, fail ? 500 : 200);
    assert.equal(entity.foto_perfil, '/uploads/fotos/antigo-sintetico.png');
  });
}
test('Importar app nao autentica, sincroniza nem inicia servidor', () => {
  const app = { use() {}, listen() { assert.fail('Servidor nao deve iniciar no import'); } };
  const express = Object.assign(() => app, { json: () => () => {}, static: () => () => {} });
  const sandbox = { module: { exports: {} }, process: { env: {} }, console: { log() {}, error() {} }, __dirname: root, require(name) {
    if (name === 'express') return express;
    if (name === 'path') return path;
    if (name === './config/sequelize') return { authenticate() { assert.fail('Nao conectar no import'); }, sync() { assert.fail('Sync proibido'); } };
    if (name.startsWith('./routes/') || name === './middlewares/publicResponse') return () => {};
    if (['cors', 'cookie-parser'].includes(name)) return () => () => {};
    throw Error('Import nao autorizado ' + name);
  }};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), sandbox);
  assert.equal(sandbox.module.exports.app, app);
});
for (const [model, file, handler] of [['Empresa', 'empresaController.js', 'CadastrarEmpresa'], ['Ict', 'ictController.js', 'CadastrarIct']]) {
  test(`Falha indeterminada no cadastro de ${model} nao remove upload`, async () => {
    const models = { Usuario: { findByPk: async () => ({ tipo: 'admin' }) }, [model]: { create: async () => { throw Error('Confirmacao sintetica perdida'); } }, sequelize: { transaction: async fn => fn({}) } };
    const api = load('controllers/' + file, { '../models': models, '../config/multerFotoPerfil': {}, fs: { unlink() { assert.fail('Upload pode estar referenciado'); } }, path });
    const r = await response(api[handler], { user: { id: 1 }, body: { nome: 'Sintetico' }, file: { filename: 'sintetico.png', path: 'uploads/fotos/sintetico.png' } });
    assert.equal(r.status, 500);
  });
}
test('Falha ao excluir ICT nao remove a imagem referenciada', async () => {
  const api = load('controllers/ictController.js', { '../models': { Usuario: { findByPk: async () => ({ tipo: 'admin' }) }, Ict: { findByPk: async () => ({ foto_perfil: '/uploads/fotos/sintetico.png', destroy: async () => { throw Error('Falha sintetica'); } }) } }, '../config/multerFotoPerfil': {}, fs: { unlink() { assert.fail('Nao remover imagem'); } }, path });
  assert.equal((await response(api.DeletarIct, { user: { id: 1 }, params: { id: '1' } })).status, 500);
});
function projectCreation(models) {
  return load('controllers/projetoController.js', { '../models': models, sequelize: { Op: {}, QueryTypes: {}, literal() {} }, '../services/projetoCanvas': require('../../services/projetoCanvas'), '../dtos/projetoDTO': { projetoDTO() {} }, fs: { unlink() { assert.fail('Nao remover upload potencialmente referenciado'); } } });
}
test('Falha apos criar Projeto mantem upload que pode estar referenciado', async () => {
  let created;
  const api = projectCreation({ Programa: { findByPk: async () => ({ Rota: { empresa_id: 10 } }) }, Projeto: { create: async data => { created = data; return { id: 1, ...data }; } }, Keyword: { findOne: async () => { throw Error('Falha sintetica apos gravacao'); } } });
  const r = await response(api.CadastrarProjeto, { user: { id: 1, tipo: 'empresa', empresa_id: 10 }, body: { programa_id: 1, keywords: 'teste' }, file: { filename: 'sintetico.pdf', path: 'uploads/arquivos/sintetico.pdf' } });
  assert.equal(r.status, 500); assert.equal(created.upload, '/uploads/arquivos/sintetico.pdf');
});
test('Cadastros concorrentes de projetos preservam o autor de cada requisicao', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const api = projectCreation({ Programa: { findByPk: async id => { if (id === 1) await gate; return { Rota: { empresa_id: 10 } }; } }, Projeto: { create: async data => ({ id: data.usuario_id, ...data }) } });
  const first = response(api.CadastrarProjeto, { user: { id: 1, tipo: 'empresa', empresa_id: 10 }, body: { programa_id: 1 } });
  const second = await response(api.CadastrarProjeto, { user: { id: 2, tipo: 'empresa', empresa_id: 10 }, body: { programa_id: 2 } });
  release(); const result = await first;
  assert.equal(result.status, 201); assert.equal(second.status, 201);
  assert.equal(result.body.usuario_id, 1); assert.equal(second.body.usuario_id, 2);
});
