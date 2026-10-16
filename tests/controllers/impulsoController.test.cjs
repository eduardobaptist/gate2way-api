'use strict';

// Node.js >= 20: node tests/controllers/impulsoController.test.cjs
// Sem dependencias externas ou acesso a banco. Locks reais exigem homologacao isolada.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture, deferred } = require('../helpers/impulsoController.fixture.cjs');

const messages = {
  invalid: 'ID do impulso inválido.',
  missing: 'Impulso não encontrado',
  denied: 'Você não tem permissão para deletar esse impulso',
  dependent: 'Não é possível excluir um impulso com projetos vinculados.',
  unsafe: 'Exclusão temporariamente bloqueada por segurança.',
  success: 'Impulso deletado com sucesso',
  error: 'Erro ao deletar Impulso',
  unknown: 'Não foi possível confirmar o resultado da exclusão. Verifique o impulso antes de tentar novamente.',
};

function assertResponse(fixture, status, message) {
  assert.equal(fixture.response.count, 1, 'uma unica resposta HTTP');
  assert.equal(fixture.response.code, status);
  assert.equal(fixture.response.body.message, message);
  assert.equal(fixture.state.active, false, 'resposta apos finalizar a transaction');
  assert.equal(fixture.snapshot(), fixture.before, 'projetos e registros relacionados preservados');
}

async function assertBlocked(options, status, message) {
  const fixture = createFixture(options);
  await fixture.run();
  assertResponse(fixture, status, message);
  assert.equal(fixture.calls.destroy.length, 0, 'operacao proibida nao chega a destroy');
  assert.equal(fixture.state.deleted, false);
  return fixture;
}

describe('SEC-01: validacao antecipada do identificador no controller', () => {
  const invalidIds = [
    '0', '00', '000', '-1', '-10', '+10', '10abc', 'abc10', 'abc',
    '10.5', '10.0', '.1', '1e1', '1E1', '1e+1', '1e-1',
    ' 10', '10 ', ' 10 ', '\t10', '10\t', '\n10', '10\n', '10\r', '10\r\n',
    '10\u2028', '10\u2029', '10\u00a0', '1 0', '2147483648', '4294967295',
    '9007199254740991', '9007199254740992', '9'.repeat(1000), '01', '0010',
    '00.1', '0x10', '0b10', 'NaN', 'Infinity', '', '\u0000', '10\u0000',
    '\u0661\u0660', '\uff11\uff10', '10 OR 1=1', "10'", '%31%30',
    null, undefined, 10, 0, true, false, [], {}, ['10'], new String('10'),
  ];
  for (const [index, id] of invalidIds.entries()) {
    const label = typeof id === 'string' && id.length > 50 ? 'string numerica longa' : String(JSON.stringify(id));
    it(`rejeita ID invalido ${index + 1}: ${label}`, async () => {
      const fixture = await assertBlocked({ id }, 400, messages.invalid);
      assert.equal(fixture.calls.transactions, 0);
      assert.equal(fixture.calls.parent.length, 0);
      assert.equal(fixture.calls.projects.length, 0);
      assert.equal(fixture.calls.metadata.length, 0);
      assert.equal(fixture.calls.commits, 0);
      assert.equal(fixture.calls.rollbacks, 0);
    });
  }
  for (const id of [1, 10, 2147483646, 2147483647]) {
    it(`aceita ID canonico no intervalo INTEGER: ${id}`, async () => {
      const fixture = createFixture({ id: String(id), recordId: id });
      await fixture.run();
      assertResponse(fixture, 200, messages.success);
      assert.equal(fixture.calls.parent[0].id, id, 'ORM recebe numero exato');
      assert.equal(fixture.calls.destroy.length, 1);
    });
  }
  it('retorna 404 para ID valido inexistente', async () => {
    const fixture = await assertBlocked({ id: '123', missing: true }, 404, messages.missing);
    assert.equal(fixture.calls.projects.length, 0);
    assert.equal(fixture.calls.metadata.length, 0);
  });
});

describe('SEC-01: autorizacao por organizacao e impulsos compartilhados', () => {
  const deniedUsers = [
    ['sem usuario', undefined], ['sem empresa', {}],
    ...[null, undefined, 0, -1, 1.5, NaN, Infinity, true, false, '', '7', [], {}]
      .map((empresa_id, index) => [`vinculo invalido ${index + 1}`, { empresa_id }]),
    ['outra empresa', { tipo: 'empresa', empresa_id: 8 }],
    ['admin sem empresa', { tipo: 'admin', empresa_id: null }],
  ];
  for (const [name, user] of deniedUsers) {
    it(`bloqueia ${name} mesmo com empresa proprietaria no body`, async () => {
      const fixture = await assertBlocked({ user }, 404, messages.denied);
      assert.equal(fixture.calls.projects.length, 0, 'autorizacao precede consulta dos dependentes');
      assert.equal(fixture.calls.metadata.length, 0);
    });
  }
  for (const ownerId of [null, undefined]) {
    it(`bloqueia impulso sem empresa definida: ${ownerId}`, async () => {
      await assertBlocked({ ownerId }, 404, messages.denied);
    });
  }
  it('nao considera dois vinculos null como autorizacao', async () => {
    await assertBlocked({ ownerId: null, user: { empresa_id: null } }, 404, messages.denied);
  });
  it('nao revela dependentes de outra organizacao', async () => {
    const fixture = await assertBlocked({ dependent: true, user: { empresa_id: 8 } }, 404, messages.denied);
    assert.equal(fixture.calls.projects.length, 0);
  });
});

describe('SEC-01: dependentes, locks e verificacao das garantias do esquema', () => {
  it('bloqueia impulso com projetos sem consultar metadados ou excluir registros', async () => {
    const fixture = await assertBlocked({ dependent: true }, 409, messages.dependent);
    assert.equal(fixture.calls.metadata.length, 0);
    const query = fixture.calls.projects[0];
    assert.deepEqual(Object.keys(query.where), ['impulso_id'], 'sem filtro que esconda dependentes');
    assert.equal(query.where.impulso_id, 10);
  });
  it('bloqueia quando os metadados nao confirmam protecao suficiente', async () => {
    await assertBlocked({ protectionConfirmed: false }, 503, messages.unsafe);
  });
  it('usa a mesma transaction nas leituras, metadados e destroy', async () => {
    const fixture = createFixture();
    await fixture.run();
    assertResponse(fixture, 200, messages.success);
    const parent = fixture.calls.parent[0].options;
    const projects = fixture.calls.projects[0];
    const metadata = fixture.calls.metadata[0].options;
    const destroy = fixture.calls.destroy[0];
    for (const options of [parent, projects, metadata, destroy]) {
      assert.equal(options.transaction, fixture.transaction);
    }
    assert.equal(parent.lock, fixture.transaction.LOCK.UPDATE);
    assert.equal(projects.lock, fixture.transaction.LOCK.UPDATE);
    assert.equal(metadata.type, 'SELECT');
    assert.deepEqual(Array.from(projects.attributes), ['id']);
    assert.deepEqual(fixture.events, [
      'begin', 'parent-lock', 'project-lock', 'metadata', 'destroy',
      'commit-attempt', 'commit', 'http:200',
    ]);
  });
  it('solicita confirmacao de FK simples, InnoDB e checagem de FK na sessao', async () => {
    const fixture = createFixture();
    await fixture.run();
    const sql = fixture.calls.metadata[0].sql;
    for (const predicate of [
      /fk\.TABLE_SCHEMA\s*=\s*DATABASE\(\)/,
      /fk\.TABLE_NAME\s*=\s*'projetos'/, /fk\.COLUMN_NAME\s*=\s*'impulso_id'/,
      /fk\.REFERENCED_TABLE_SCHEMA\s*=\s*DATABASE\(\)/,
      /fk\.REFERENCED_TABLE_NAME\s*=\s*'impulsos'/, /fk\.REFERENCED_COLUMN_NAME\s*=\s*'id'/,
      /filha\.ENGINE\s*=\s*'InnoDB'/, /pai\.ENGINE\s*=\s*'InnoDB'/,
      /@@SESSION\.foreign_key_checks\s*=\s*1/,
      /COUNT\(\*\)/, /coluna\.CONSTRAINT_NAME\s*=\s*fk\.CONSTRAINT_NAME/, /\)\s*=\s*1/,
    ]) assert.match(sql, predicate);
    assert.match(sql, /^\s*SELECT\b/);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/i);
  });
});

describe('SEC-01: falhas transacionais e confirmacao de commit', () => {
  for (const failAt of ['parent', 'projects', 'metadata', 'destroy', 'after-destroy']) {
    it(`falha em ${failAt} provoca rollback confirmado na simulacao`, async () => {
      const fixture = createFixture({ failAt });
      await fixture.run();
      assertResponse(fixture, 500, messages.error);
      assert.equal(fixture.calls.transactions, 1);
      assert.equal(fixture.calls.commits, 0);
      assert.equal(fixture.calls.rollbacks, 1);
      assert.equal(fixture.state.outcome, 'rolled-back');
      assert.equal(fixture.state.deleted, false);
      assert.equal(fixture.calls.destroy.length, ['destroy', 'after-destroy'].includes(failAt) ? 1 : 0);
    });
  }
  it('falha ao abrir transaction nao inicia consultas nem exclusao', async () => {
    const fixture = await assertBlocked({ failAt: 'begin' }, 500, messages.error);
    assert.equal(fixture.calls.parent.length, 0);
    assert.equal(fixture.calls.metadata.length, 0);
    assert.equal(fixture.calls.commits, 0);
  });
  it('nao afirma rollback se a tentativa de rollback falhar', async () => {
    const fixture = createFixture({ failAt: 'after-destroy', rollbackFails: true });
    await fixture.run();
    assertResponse(fixture, 500, messages.error);
    assert.equal(fixture.calls.rollbacks, 0, 'nenhum rollback confirmado');
    assert.equal(fixture.state.outcome, 'indeterminate');
    assert.equal(fixture.calls.commits, 0);
    assert.doesNotMatch(fixture.response.body.message, /rollback|desfeit/i);
  });
  for (const commitApplied of [false, true]) {
    it(`perda de confirmacao permanece indeterminada com commitApplied=${commitApplied}`, async () => {
      const fixture = createFixture({ failAt: 'commit', commitApplied });
      await fixture.run();
      assertResponse(fixture, 500, messages.unknown);
      assert.equal(fixture.state.outcome, 'indeterminate');
      assert.equal(fixture.state.deleted, commitApplied, 'resultado conhecido apenas pelo mock');
      assert.equal(fixture.calls.transactions, 1);
      assert.equal(fixture.calls.destroy.length, 1, 'sem repetir exclusao');
      assert.equal(fixture.calls.commits, 1, 'sem repetir commit');
      assert.equal(fixture.calls.rollbacks, 0, 'sem presumir rollback');
    });
  }
  it('aguarda a confirmacao do commit antes de responder sucesso', async () => {
    const commitGate = deferred();
    const fixture = createFixture({ commitGate });
    const execution = fixture.run();
    await fixture.commitReached.promise;
    try {
      assert.equal(fixture.response.count, 0, 'commit ainda nao confirmado');
      assert.equal(fixture.state.pendingDelete, true);
      assert.equal(fixture.state.deleted, false);
    } finally {
      commitGate.resolve();
      await execution;
    }
    assertResponse(fixture, 200, messages.success);
    assert.equal(fixture.state.outcome, 'committed');
  });
  it('nao tenta responder novamente se o envio da resposta falhar apos o commit', async () => {
    const fixture = createFixture({ responseFails: true });
    await assert.rejects(fixture.run(), /Falha simulada de teste/);
    assert.equal(fixture.response.count, 1);
    assert.equal(fixture.state.outcome, 'committed');
    assert.equal(fixture.calls.destroy.length, 1);
    assert.equal(fixture.calls.rollbacks, 0);
  });
});
