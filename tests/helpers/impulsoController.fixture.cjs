'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { Script } = require('node:vm');

const controllerPath = resolve(__dirname, '../../controllers/impulsoController.js');
const controllerScript = new Script(readFileSync(controllerPath, 'utf8'), {
  filename: controllerPath,
});

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

// Todos os models, consultas e efeitos transacionais sao simulados.
// O mock distingue falhas do callback de perda de confirmacao do COMMIT;
// ele nao comprova locks, cascatas ou rollback no MySQL real.
function createFixture(options = {}) {
  const events = [];
  const calls = {
    transactions: 0, commits: 0, rollbacks: 0,
    parent: [], projects: [], metadata: [], destroy: [],
  };
  const state = { active: false, pendingDelete: false, deleted: false, outcome: 'not-started' };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const commitReached = deferred();
  const failure = new Error('Falha simulada de teste');
  const impulso = {
    id: options.recordId ?? 10,
    empresa_id: Object.hasOwn(options, 'ownerId') ? options.ownerId : 7,
    async destroy(opts) {
      calls.destroy.push(opts);
      events.push('destroy');
      if (options.failAt === 'destroy') throw failure;
      state.pendingDelete = true;
      if (options.failAt === 'after-destroy') throw failure;
    },
  };
  const projects = [{ id: 101, impulso_id: 99 }];
  if (options.dependent) projects.push({ id: 102, impulso_id: impulso.id });
  const related = {
    ofertas: [{ id: 201, projeto_id: options.dependent ? 102 : 101 }],
    interesses: [{ id: 301, oferta_id: 201 }],
    parcerias: [{ id: 401, interesse_id: 301 }],
    projetoKeywords: [{ projeto_id: options.dependent ? 102 : 101, keyword_id: 501 }],
    projectViews: [{ project_id: options.dependent ? 102 : 101 }],
  };
  const snapshot = () => JSON.stringify({ projects, related });
  const before = snapshot();

  const sequelize = {
    async transaction(callback) {
      calls.transactions++;
      events.push('begin');
      if (options.failAt === 'begin') throw failure;
      state.active = true;
      state.outcome = 'active';
      let result;
      try {
        result = await callback(transaction);
      } catch (error) {
        events.push('rollback-attempt');
        state.active = false;
        if (options.rollbackFails) {
          state.outcome = 'indeterminate';
          throw error;
        }
        calls.rollbacks++;
        state.pendingDelete = false;
        state.deleted = false;
        state.outcome = 'rolled-back';
        events.push('rollback');
        throw error;
      }

      // Falhas daqui em diante nao devem ser convertidas em rollback confirmado.
      calls.commits++;
      events.push('commit-attempt');
      commitReached.resolve();
      if (options.commitGate) await options.commitGate.promise;
      state.active = false;
      if (options.failAt === 'commit') {
        state.deleted = options.commitApplied === true && state.pendingDelete;
        state.outcome = 'indeterminate';
        throw failure;
      }
      state.deleted = state.pendingDelete;
      state.outcome = 'committed';
      events.push('commit');
      return result;
    },
    async query(sql, opts) {
      calls.metadata.push({ sql, options: opts });
      events.push('metadata');
      if (options.failAt === 'metadata') throw failure;
      return options.protectionConfirmed === false ? [] : [{ protegida: 1 }];
    },
  };
  const models = {
    sequelize,
    Impulso: {
      async findByPk(id, opts) {
        calls.parent.push({ id, options: opts });
        events.push('parent-lock');
        if (options.failAt === 'parent') throw failure;
        return options.missing || id !== impulso.id ? null : impulso;
      },
    },
    Projeto: {
      async findOne(opts) {
        calls.projects.push(opts);
        events.push('project-lock');
        if (options.failAt === 'projects') throw failure;
        return projects.find(project => project.impulso_id === opts.where.impulso_id) ?? null;
      },
    },
  };

  const moduleMock = { exports: {} };
  controllerScript.runInNewContext({
    module: moduleMock,
    exports: moduleMock.exports,
    console: { log() {}, error() {} },
    require(name) {
      if (name === '../models') return models;
      if (name === 'sequelize') return { Op: { or: Symbol('or') }, QueryTypes: { SELECT: 'SELECT' } };
      // Nao delegar a require real: models/index, config, app e drivers nunca sao importados.
      throw new Error(`Importacao nao simulada no teste: ${name}`);
    },
  });

  const response = {
    code: null, body: null, count: 0,
    status(code) { this.code = code; return this; },
    json(body) {
      this.count++;
      this.body = body;
      events.push(`http:${this.code}`);
      if (options.responseFails) throw failure;
      return this;
    },
  };
  const user = Object.hasOwn(options, 'user') ? options.user : { id: 1, tipo: 'empresa', empresa_id: 7 };
  const request = {
    params: { id: Object.hasOwn(options, 'id') ? options.id : '10' },
    user,
    body: { empresa_id: 7 },
  };
  return {
    calls, state, events, transaction, response, request, before, snapshot, commitReached,
    run: () => moduleMock.exports.DeletarImpulso(request, response),
  };
}

module.exports = { createFixture, deferred };
