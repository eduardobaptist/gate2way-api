const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ tipo = 'empresa', missing, duplicate = false, failure } = {}) {
  let rows = duplicate ? [{ usuario_id: 1, empresa_id: 2, ict_id: null, cargo: null }] : [];
  const events = [];
  const tx = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
  let queue = Promise.resolve();
  const options = o => assert.equal(o.transaction, tx);
  const models = {
    Usuario: { findByPk: async (id, o) => {
      options(o); assert.equal(o.lock, tx.LOCK.UPDATE); events.push('user');
      return missing === 'user' ? null : { id, tipo };
    } },
    Empresa: { findByPk: async (id, o) => {
      options(o); assert.equal(o.lock, tx.LOCK.SHARE); events.push('company');
      return missing === 'company' ? null : { id };
    } },
    Ict: { findByPk: async (id, o) => {
      options(o); assert.equal(o.lock, tx.LOCK.SHARE); events.push('ict');
      return missing === 'ict' ? null : { id };
    } },
    Responsavel: {
      findByPk: async (id, o) => { options(o); return rows.find(row => row.usuario_id === id); },
      create: async (data, o) => {
        options(o); events.push('create');
        rows.push(JSON.parse(JSON.stringify(data)));
        if (failure) throw Object.assign(new Error('Falha sintética'), { name: failure });
        return data;
      },
    },
    sequelize: { transaction: async fn => {
      const previous = queue;
      let release; queue = new Promise(resolve => { release = resolve; });
      await previous;
      const before = structuredClone(rows); events.push('begin');
      try { const result = await fn(tx); events.push('commit'); return result; }
      catch (error) { rows = before; events.push('rollback'); throw error; }
      finally { release(); }
    } },
  };
  const sandbox = { module: { exports: {} }, console: { error() {} }, require(name) {
    if (name === '../models') return models;
    if (name === 'sequelize') return { Op: {} };
    throw Error('Importação não permitida: ' + name);
  } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../controllers/responsavelController.js'), 'utf8'), sandbox);
  return { events, rows: () => structuredClone(rows), async run(body, user = { tipo: 'admin' }) {
    const replies = [];
    await sandbox.module.exports.CadastrarResponsavel({ body, user }, {
      status(code) { this.code = code; return this; },
      json(data) { events.push('response'); replies.push({ status: this.code, data: JSON.parse(JSON.stringify(data)) }); },
    });
    assert.equal(replies.length, 1);
    return replies[0];
  } };
}

const valid = () => ({ usuario_id: 1, empresa_id: 2, ict_id: null, cargo: 'Pesquisa' });
const invalid = [undefined, null, 0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity,
  '', '0', '-1', '1.1', '1e2', '01', ' 1', '1 ', '1\n', true, false, [], {}, [1]];
for (const field of ['usuario_id', 'empresa_id', 'ict_id']) {
  for (const value of invalid) {
    if (field !== 'usuario_id' && value == null) continue;
    test(`ID inválido ${field}: ${String(value)} (${typeof value})`, async () => {
      const f = fixture();
      assert.equal((await f.run({ ...valid(), [field]: value })).status, 400);
      assert.deepEqual(f.rows(), []); assert.deepEqual(f.events, ['response']);
    });
  }
}
for (const body of [null, undefined, [], 'texto', 1]) {
  test('Corpo inválido: ' + JSON.stringify(body), async () => {
    const f = fixture(); assert.equal((await f.run(body)).status, 400); assert.deepEqual(f.events, ['response']);
  });
}
for (const user of [undefined, null, {}, { tipo: 'empresa' }, { tipo: 'ict' }]) {
  test('Sem permissão: ' + JSON.stringify(user), async () => {
    const f = fixture(); assert.equal((await f.run(valid(), user === undefined ? {} : user)).status, 403);
    assert.deepEqual(f.events, ['response']); assert.deepEqual(f.rows(), []);
  });
}
for (const cargo of [false, 12, {}, [], 'x'.repeat(256)]) {
  test('Cargo inválido: ' + typeof cargo, async () => {
    const f = fixture(); assert.equal((await f.run({ ...valid(), cargo })).status, 400); assert.deepEqual(f.rows(), []);
  });
}
for (const [tipo, empresa_id, ict_id] of [
  ['empresa', null, null], ['ict', null, null], ['empresa', null, 3], ['ict', 2, null],
  ['admin', 2, null], ['admin', null, 3], ['empresa', 2, 3], ['desconhecido', 2, null],
]) {
  test(`Vínculo incompatível ou ausente: ${tipo}/${empresa_id}/${ict_id}`, async () => {
    const f = fixture({ tipo });
    assert.equal((await f.run({ ...valid(), empresa_id, ict_id })).status, 400);
    assert.deepEqual(f.rows(), []); assert.ok(!f.events.includes('create'));
  });
}
for (const [missing, tipo, empresa_id, ict_id] of [
  ['user', 'empresa', 2, null], ['company', 'empresa', 2, null], ['ict', 'ict', null, 3],
]) {
  test('Entidade inexistente: ' + missing, async () => {
    const f = fixture({ tipo, missing });
    assert.equal((await f.run({ ...valid(), empresa_id, ict_id })).status, 404);
    assert.deepEqual(f.rows(), []); assert.ok(!f.events.includes('create'));
  });
}
for (const [tipo, empresa_id, ict_id] of [['empresa', '2', null], ['ict', null, '3'], ['admin', null, null]]) {
  test('Cadastro válido e campos extras ignorados: ' + tipo, async () => {
    const f = fixture({ tipo });
    const result = await f.run({ usuario_id: '1', empresa_id, ict_id, cargo: null, tipo: 'admin', createdAt: 'injetado', id: 123 });
    assert.equal(result.status, 201);
    assert.deepEqual(f.rows(), [{ usuario_id: 1, empresa_id: empresa_id === null ? null : 2, ict_id: ict_id === null ? null : 3, cargo: null }]);
    assert.ok(f.events.indexOf('commit') < f.events.indexOf('response'));
  });
}
test('Duplicado preserva o vínculo existente', async () => {
  const f = fixture({ duplicate: true }); const before = f.rows();
  assert.equal((await f.run(valid())).status, 409); assert.deepEqual(f.rows(), before);
  assert.ok(!f.events.includes('create'));
});
test('Duas solicitações do mesmo usuário não criam dois vínculos', async () => {
  const f = fixture(); const result = await Promise.all([f.run(valid()), f.run(valid())]);
  assert.deepEqual(result.map(r => r.status), [201, 409]); assert.equal(f.rows().length, 1);
});
for (const [failure, status] of [['SequelizeUniqueConstraintError', 409], ['SequelizeForeignKeyConstraintError', 404], ['SequelizeValidationError', 400], ['Error', 500]]) {
  test('Rollback em falha: ' + failure, async () => {
    const f = fixture({ failure }); assert.equal((await f.run(valid())).status, status);
    assert.deepEqual(f.rows(), []); assert.ok(f.events.includes('rollback'));
  });
}
