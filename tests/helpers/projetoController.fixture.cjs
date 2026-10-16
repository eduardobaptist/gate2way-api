const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const canvas = require('../../services/projetoCanvas');

function project() {
  const fields = Object.fromEntries(canvas.CAMPOS_CANVAS.map(key => [key, `Texto ${key}`]));
  const widgets = Object.fromEntries(Object.entries(fields).map(([key, text]) =>
    [key, { x: 0, y: 0, w: 2, h: 1, textarea_value: text, extra: { keep: true } }]));
  return { id: 7, nome: 'Projeto sintético', descricao: 'Descrição sintética',
    status: 'NÃO PÚBLICADO', Programa: { Rota: { empresa_id: 10 } },
    upload: '/uploads/arquivos/sintetico.pdf', ...fields,
    estilo: { ...widgets, historico: { tipo: 'opaco', dados: [1, null, 'preservar'] } } };
}

function harness(options = {}) {
  let stored = structuredClone(options.initial || project());
  const events = [];
  const writes = [];
  const committedResults = new WeakSet();
  let queue = Promise.resolve();
  let active;
  const sequelize = {
    getDialect: () => options.dialect || 'mysql',
    async query(sql, args) {
      assert.equal(args.transaction, active);
      events.push('metadata');
      if (options.metadataError) throw new Error('Falha sintética');
      if (sql.includes('CAST(estilo AS CHAR)')) {
        assert.equal(args.replacements.id, active.row.id);
        return [{ estilo_raw: options.rawStyle !== undefined ? options.rawStyle :
          active.row.estilo == null ? null : JSON.stringify(active.row.estilo) }];
      }
      assert.equal(args.replacements.table, 'projetos');
      if (sql.includes('information_schema.TABLES')) return options.tables || [{ engine: 'InnoDB' }];
      assert.equal(args.replacements.column, 'estilo');
      return options.columns || [{ data_type: 'json' }];
    },
    async transaction(callback) {
      const previous = queue;
      let release;
      queue = new Promise(resolve => { release = resolve; });
      await previous;
      events.push('begin');
      const tx = { LOCK: { UPDATE: 'UPDATE' }, row: structuredClone(stored), reads: 0 };
      active = tx;
      try {
        if (options.beginError) throw new Error('Falha sintética');
        const result = await callback(tx);
        events.push('commit-attempt');
        if (options.beforeCommit) await options.beforeCommit();
        if (!options.commitError || options.commitApplied) stored = structuredClone(tx.row);
        if (options.commitError) throw new Error('Confirmação perdida');
        events.push('commit');
        committedResults.add(result);
        return result;
      } catch (error) {
        if (!events.includes('commit-attempt') || !(options.commitError)) {
          if (options.rollbackError) {
            events.push('rollback-failed');
            throw new Error('Falha sintética no rollback');
          }
          events.push('rollback');
        }
        throw error;
      } finally { active = undefined; release(); }
    },
  };
  const Projeto = {
    async findByPk(id, args) {
      assert.equal(args.transaction, active);
      assert.equal(args.lock, active.LOCK.UPDATE);
      events.push('lock');
      if (options.findError) throw new Error('Falha sintética');
      if (options.missing) return null;
      const tx = active;
      tx.reads++;
      let data = structuredClone(tx.row);
      if (options.corruptReload && tx.reads > 1) data = options.corruptReload(data);
      return {
        ...data,
        toJSON() { return structuredClone(data); },
        async update(changes, updateOptions) {
          assert.equal(updateOptions.transaction, tx);
          events.push('update');
          writes.push(structuredClone(changes));
          if (options.updateError) throw new Error('Falha sintética');
          Object.assign(tx.row, changes);
          // Simulate a JSON SQL column decoded by mysql2, including JSON strings.
          if (Object.hasOwn(changes, 'estilo')) tx.row.estilo = JSON.parse(changes.estilo);
        },
      };
    },
  };
  const models = { Projeto, sequelize, ProjectView: {
    async create() { events.push('view-simulated'); },
  } };
  const filename = path.resolve(__dirname, '../../controllers/projetoController.js');
  const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(filename),
    console: { error() {}, log() {} },
    require(name) {
      if (name === '../models') return models;
      if (name === '../services/projetoCanvas') return canvas;
      if (name === '../dtos/projetoDTO') return {};
      if (name === 'sequelize') return { Op: {}, QueryTypes: { SELECT: 'SELECT' }, literal: value => value };
      if (name === 'path') return path;
      if (name === 'fs') return { unlink() { assert.fail('Exclusão de arquivo proibida'); } };
      throw new Error(`Importação proibida: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  async function run(body, extra = {}) {
    const replies = [];
    const res = {
      statusCode: 200,
      status(value) { this.statusCode = value; return this; },
      json(value) {
        replies.push({ status: this.statusCode, body: JSON.parse(JSON.stringify(value)) });
        events.push(`response:${this.statusCode}`);
        if (this.statusCode === 200) assert.ok(committedResults.has(value));
        if (options.responseError) throw new Error('Resposta interrompida');
        return this;
      },
    };
    await sandbox.module.exports.AtualizarProjeto({ params: { id: '7' },
      user: { tipo: 'empresa', empresa_id: 10 }, body, ...extra }, res);
    assert.equal(replies.length, 1);
    return replies[0];
  }
  async function read() {
    // GET has no transaction in the existing API. Only substitute its model
    // lookup; do not import the application or execute its startup routines.
    const original = Projeto.findByPk;
    Projeto.findByPk = async () => ({ ...structuredClone(stored),
      toJSON: () => structuredClone(stored) });
    const replies = [];
    const res = { status(code) { this.code = code; return this; },
      json(body) { replies.push({ status: this.code, body }); } };
    try {
      await sandbox.module.exports.SelecionarProjeto({ params: { id: '7' },
        user: { tipo: 'empresa', empresa_id: 10 } }, res);
    } finally { Projeto.findByPk = original; }
    assert.equal(replies.length, 1);
    return replies[0];
  }
  return { run, read, events, writes, stored: () => structuredClone(stored) };
}

module.exports = { project, harness, canvas };
