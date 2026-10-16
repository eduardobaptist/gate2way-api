const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, project, canvas } = require('../helpers/projetoController.fixture.cjs');
const styleOf = value => typeof value === 'string' ? JSON.parse(value) : value;

// The transaction and row locks below are simulations, not MySQL lock tests.
function patch(initial, set = { justificativas: 'Novo conteúdo' }, clear = []) {
  return { canvas_revision: canvas.revision(initial), canvas_patch: { set, clear } };
}
function preserved(before, after) {
  for (const key of ['estilo', ...canvas.CAMPOS_CANVAS]) assert.deepEqual(after[key], before[key]);
}

for (const field of ['nome', 'descricao']) {
  for (const format of ['object', 'string', 'opaque', 'array', 'null', 'absent']) {
    test(`edição apenas de ${field} preserva Canvas ${format}`, async () => {
      const initial = project();
      if (format === 'string') initial.estilo = JSON.stringify(initial.estilo);
      if (format === 'opaque') initial.estilo = 'formato histórico não interpretado';
      if (format === 'array') initial.estilo = [{ legado: true }];
      if (format === 'null') initial.estilo = null;
      if (format === 'absent') delete initial.estilo;
      initial.custos = null;
      delete initial.riscos;
      const h = harness({ initial });
      assert.equal((await h.run({ [field]: 'Alteração geral' })).status, 200);
      assert.equal(h.stored()[field], 'Alteração geral');
      preserved(initial, h.stored());
      assert.deepEqual(h.writes, [{ [field]: 'Alteração geral' }]);
    });
  }
}

for (const format of ['object', 'string', 'null', 'absent']) {
  test(`patch de texto conserva conteúdo adicional: ${format}`, async () => {
    const initial = project();
    const original = structuredClone(initial.estilo);
    if (format === 'string') initial.estilo = JSON.stringify(initial.estilo);
    if (format === 'null') initial.estilo = null;
    if (format === 'absent') delete initial.estilo;
    const h = harness({ initial });
    const response = await h.run(patch(initial));
    assert.equal(response.status, 200);
    const stored = h.stored();
    const style = styleOf(stored.estilo);
    assert.equal(style.justificativas.textarea_value, 'Novo conteúdo');
    assert.equal(stored.justificativas, 'Novo conteúdo');
    for (const key of canvas.CAMPOS_CANVAS.filter(key => key !== 'justificativas')) {
      assert.equal(stored[key], initial[key]);
      if (format === 'string' || format === 'object') assert.deepEqual(style[key], original[key]);
    }
    if (format === 'string' || format === 'object') {
      assert.deepEqual(style.historico, original.historico);
      assert.deepEqual(style.justificativas.extra, original.justificativas.extra);
      assert.equal(style.justificativas.w, original.justificativas.w);
    }
    assert.equal(response.body.canvas_revision, canvas.revision(stored));
  });
}

test('limpeza explícita limpa apenas o campo solicitado nas duas representações', async () => {
  const initial = project();
  const h = harness({ initial });
  assert.equal((await h.run(patch(initial, {}, ['custos']))).status, 200);
  const after = h.stored();
  assert.equal(after.custos, '');
  assert.equal(styleOf(after.estilo).custos.textarea_value, '');
  assert.equal(after.justificativas, initial.justificativas);
});

for (const style of ['legado opaco', 'null', '[]', { justificativas: 'texto direto' }, { justificativas: null }]) {
  test(`formato incompatível bloqueia patch sem alterações parciais: ${JSON.stringify(style)}`, async () => {
    const initial = { ...project(), estilo: style };
    const h = harness({ initial });
    const response = await h.run({ nome: 'Não persistir', ...patch(initial) });
    assert.equal(response.status, 409);
    assert.deepEqual(h.stored(), initial);
    assert.equal(h.writes.length, 0);
  });
}

test('divergência no campo editado bloqueia a operação completa', async () => {
  const initial = project();
  initial.justificativas = 'Texto individual diferente';
  const h = harness({ initial });
  const response = await h.run(patch(initial));
  assert.equal(response.body.code, 'CANVAS_DIVERGENT');
  assert.deepEqual(h.stored(), initial);
});

test('divergências não editadas e propriedades desconhecidas são conservadas', async () => {
  const initial = project();
  initial.custos = 'Representação individual histórica';
  const h = harness({ initial });
  assert.equal((await h.run(patch(initial))).status, 200);
  assert.equal(h.stored().custos, initial.custos);
  assert.deepEqual(styleOf(h.stored().estilo).custos, initial.estilo.custos);
});

test('payload legado completo e idêntico permite alteração geral sem regravar Canvas', async () => {
  const initial = project();
  const body = Object.fromEntries(['estilo', ...canvas.CAMPOS_CANVAS].map(key => [key, initial[key]]));
  body.estilo = JSON.stringify(body.estilo);
  const h = harness({ initial });
  assert.equal((await h.run({ ...body, nome: 'Novo título' })).status, 200);
  preserved(initial, h.stored());
  assert.deepEqual(h.writes, [{ nome: 'Novo título' }]);
});

for (const body of [{ estilo: '{}' }, { justificativas: '' }, { custos: null }, { estilo: null }]) {
  test(`payload legado destrutivo é bloqueado: ${JSON.stringify(body)}`, async () => {
    const initial = project();
    const h = harness({ initial });
    assert.equal((await h.run({ ...body, nome: 'Não gravar' })).status, 428);
    assert.deepEqual(h.stored(), initial);
    assert.equal(h.writes.length, 0);
  });
}

for (const value of [null, 'inválido', [], {}, { set: null }, { clear: 'custos' },
  { set: { custos: '' } }, { set: { custos: null } }, { set: { custos: 1 } },
  { set: { custos: 'x'.repeat(256) } }, { set: { desconhecido: 'x' } },
  { clear: ['custos', 'custos'] }, { set: { custos: 'x' }, clear: ['custos'] },
  { clear: ['__proto__'] }, { set: {}, extra: true }]) {
  test(`patch malformado rejeitado: ${JSON.stringify(value)}`, async () => {
    const h = harness();
    assert.equal((await h.run({ canvas_patch: value, canvas_revision: canvas.revision(project()) })).status, 400);
    assert.equal(h.writes.length, 0);
  });
}

test('multipart aceita JSON no campo canvas_patch, sem alterar espaços', async () => {
  const initial = project();
  const body = patch(initial, { justificativas: '  texto com espaços  ' });
  body.canvas_patch = JSON.stringify(body.canvas_patch);
  const h = harness({ initial });
  assert.equal((await h.run(body)).status, 200);
  assert.equal(h.stored().justificativas, '  texto com espaços  ');
});

test('contratos misturados são rejeitados', async () => {
  const h = harness();
  assert.equal((await h.run({ ...patch(project()), estilo: '{}' })).status, 400);
  assert.equal(h.writes.length, 0);
});

for (const token of [undefined, null, '', 'invalida', 'f'.repeat(64)]) {
  test(`revisão ausente, inválida ou vencida: ${token}`, async () => {
    const h = harness();
    const response = await h.run({ ...patch(project()), canvas_revision: token });
    assert.equal(response.status, token === 'f'.repeat(64) ? 409 : 428);
    assert.equal(h.writes.length, 0);
  });
}

test('revisão inclui o projeto e todos os campos, widgets e propriedades', () => {
  const initial = project();
  const original = canvas.revision(initial);
  for (const key of ['id', ...canvas.CAMPOS_CANVAS]) {
    assert.notEqual(canvas.revision({ ...initial, [key]: 'Outro valor' }), original);
  }
  const changed = structuredClone(initial);
  changed.estilo.historico.dados.push('Mudou');
  assert.notEqual(canvas.revision(changed), original);
  assert.equal(canvas.revision({ ...initial, nome: 'Novo título' }), original);
});

test('duas edições com mesma revisão: apenas a primeira persiste', async () => {
  const initial = project();
  const h = harness({ initial });
  const results = await Promise.all([
    h.run(patch(initial, { justificativas: 'Primeiro' })),
    h.run(patch(initial, { justificativas: 'Segundo' })),
  ]);
  assert.deepEqual(results.map(result => result.status), [200, 409]);
  assert.equal(h.stored().justificativas, 'Primeiro');
  assert.equal(h.writes.length, 1);
});

for (const settings of [{ missing: true }, { user: { tipo: 'empresa', empresa_id: 99 } },
  { published: true }]) {
  test(`permissões e estado preservados: ${JSON.stringify(settings)}`, async () => {
    const initial = project();
    if (settings.published) initial.status = 'PUBLICADO';
    const h = harness({ initial, missing: settings.missing });
    const response = await h.run(patch(initial), settings.user ? { user: settings.user } : {});
    assert.equal(response.status, settings.missing ? 404 : settings.user ? 403 : 400);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.stored(), initial);
  });
}

test('administrador mantém a permissão existente', async () => {
  const h = harness();
  assert.equal((await h.run({ nome: 'Admin' }, { user: { tipo: 'admin' } })).status, 200);
});

for (const options of [{ dialect: 'sqlite' }, { tables: [] }, { tables: [{ engine: 'MyISAM' }] },
  { columns: [] }, { columns: [{ data_type: 'varchar' }] }]) {
  test(`armazenamento não confirmado falha fechado: ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    assert.equal((await h.run(patch(project()))).status, 503);
    assert.equal(h.writes.length, 0);
  });
}

for (const option of ['beginError', 'metadataError', 'findError', 'updateError']) {
  test(`falha ${option} não confirma gravação`, async () => {
    const initial = project();
    const h = harness({ initial, [option]: true });
    assert.equal((await h.run(patch(initial))).status, 500);
    assert.deepEqual(h.stored(), initial);
    assert.ok(h.events.includes('rollback'));
    assert.ok(!h.events.includes('commit'));
  });
}

for (const commitApplied of [false, true]) {
  test(`commit indeterminado, aplicação simulada=${commitApplied}`, async () => {
    const initial = project();
    const h = harness({ initial, commitError: true, commitApplied });
    const response = await h.run(patch(initial));
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'PROJECT_COMMIT_UNKNOWN');
    assert.equal(h.events.filter(event => event === 'update').length, 1);
    assert.ok(!h.events.includes('rollback'));
    assert.equal(h.stored().justificativas, commitApplied ? 'Novo conteúdo' : initial.justificativas);
  });
}

test('conversão ou truncamento na persistência provoca rejeição e rollback simulado', async () => {
  const initial = project();
  const h = harness({ initial, corruptReload(row) { row.justificativas = 'truncado'; return row; } });
  const response = await h.run(patch(initial));
  assert.equal(response.body.code, 'CANVAS_PERSISTENCE_MISMATCH');
  assert.deepEqual(h.stored(), initial);
  assert.ok(h.events.includes('rollback'));
});

test('falha de serialização preserva tudo e não chega à persistência', () => {
  const initial = project();
  initial.estilo.historico.dados.push(undefined);
  assert.throws(() => canvas.updates(initial, patch(initial)), /serializar/);
});

test('sem exclusão do anexo anterior quando atualização é rejeitada', async () => {
  const initial = project();
  const h = harness({ initial });
  assert.equal((await h.run({ estilo: '{}' }, { file: { filename: 'novo.pdf', path: 'sintetico' } })).status, 428);
  assert.deepEqual(h.stored(), initial);
});

test('substituição válida mantém referência nova sem excluir arquivos', async () => {
  const h = harness();
  assert.equal((await h.run({ nome: 'Novo' }, { file: { filename: 'novo.pdf' } })).status, 200);
  assert.equal(h.stored().upload, '/uploads/arquivos/novo.pdf');
});

test('sucesso só é respondido após confirmação do commit', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness({ beforeCommit: () => pending });
  const run = h.run({ nome: 'Novo' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.events.includes('commit-attempt'));
  assert.ok(!h.events.some(event => event.startsWith('response:')));
  release();
  assert.equal((await run).status, 200);
});

test('falha ao enviar resposta não dispara resposta duplicada ou novo update', async () => {
  const h = harness({ responseError: true });
  await assert.rejects(h.run({ nome: 'Novo' }), /Resposta interrompida/);
  assert.equal(h.events.filter(event => event.startsWith('response:')).length, 1);
  assert.equal(h.writes.length, 1);
});

for (const format of ['object', 'string', 'unknown', 'null']) {
  test(`consulta fornece revisão sem converter Canvas ${format}`, async () => {
    const initial = project();
    if (format === 'string') initial.estilo = JSON.stringify(initial.estilo);
    if (format === 'unknown') initial.estilo = 'histórico opaco';
    if (format === 'null') initial.estilo = null;
    const h = harness({ initial });
    const result = await h.read();
    assert.equal(result.status, 200);
    assert.equal(result.body.canvas_revision, canvas.revision(initial));
    preserved(initial, result.body);
    assert.deepEqual(h.stored(), initial);
    assert.equal(h.writes.length, 0);
  });
}

for (const field of canvas.CAMPOS_CANVAS) {
  test(`patch individual de ${field} preserva as outras 12 colunas`, async () => {
    const initial = project();
    const h = harness({ initial });
    assert.equal((await h.run(patch(initial, { [field]: 'Novo texto' }))).status, 200);
    assert.equal(h.stored()[field], 'Novo texto');
    for (const other of canvas.CAMPOS_CANVAS.filter(key => key !== field)) {
      assert.equal(h.stored()[other], initial[other]);
    }
    assert.equal(typeof h.stored().estilo, 'object');
  });
}

test('JSON string dentro da coluna JSON continua string após patch', async () => {
  const initial = project();
  initial.estilo = JSON.stringify(initial.estilo);
  const h = harness({ initial });
  assert.equal((await h.run(patch(initial))).status, 200);
  assert.equal(typeof h.stored().estilo, 'string');
  assert.equal(JSON.parse(h.stored().estilo).justificativas.textarea_value, 'Novo conteúdo');
});

for (const token of ['9007199254740993', '0.1234567890123456789', '1.00', '1e2', '-0']) {
  test(`número histórico potencialmente convertido é bloqueado: ${token}`, async () => {
    const original = project();
    const rawStyle = JSON.stringify(original.estilo).replace('"dados":[1,null,"preservar"]', `"dados":[${token},null,"preservar"]`);
    const initial = { ...original, estilo: JSON.parse(rawStyle) };
    const h = harness({ initial, rawStyle });
    const response = await h.run(patch(initial));
    assert.equal(response.status, 409);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.stored(), initial);
  });
}

test('valores numéricos dentro de texto não são interpretados nem descartados', async () => {
  const initial = project();
  initial.estilo.historico.texto = '9007199254740993 e 1e2 são texto';
  const h = harness({ initial });
  assert.equal((await h.run(patch(initial))).status, 200);
  assert.equal(styleOf(h.stored().estilo).historico.texto, initial.estilo.historico.texto);
});

test('leitura textual divergente bloqueia gravação', async () => {
  const h = harness({ rawStyle: '{}' });
  const response = await h.run(patch(project()));
  assert.equal(response.body.code, 'CANVAS_STORAGE_MISMATCH');
  assert.equal(h.writes.length, 0);
});

test('objeto histórico sem widgets conhecidos não é convertido', async () => {
  const initial = { ...project(), estilo: { versao: 'antiga', blocos: { texto: 'manter' } } };
  const h = harness({ initial });
  assert.equal((await h.run(patch(initial))).status, 409);
  assert.deepEqual(h.stored(), initial);
});

test('falha após anexar arquivo conserva arquivo anterior e todo o registro', async () => {
  const initial = project();
  const h = harness({ initial, updateError: true });
  assert.equal((await h.run({ nome: 'Novo' }, { file: { filename: 'novo.pdf' } })).status, 500);
  assert.deepEqual(h.stored(), initial);
});

test('alteração geral não invalida revisão do Canvas', async () => {
  const initial = project();
  const h = harness({ initial });
  assert.equal((await h.run({ nome: 'Título concorrente' })).status, 200);
  assert.equal((await h.run(patch(initial))).status, 200);
  assert.equal(h.stored().nome, 'Título concorrente');
});

test('propriedades duplicadas em JSON histórico não são descartadas por conversão', async () => {
  const initial = project();
  initial.estilo = JSON.stringify(initial.estilo).replace('"tipo":"opaco"', '"tipo":"primeiro","tipo":"opaco"');
  const h = harness({ initial });
  assert.equal((await h.run(patch(initial))).status, 409);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.stored(), initial);
});

test('novos textos com caracteres Unicode respeitam limite em caracteres', async () => {
  const initial = project();
  const h = harness({ initial });
  const text = '🌱'.repeat(255);
  assert.equal((await h.run(patch(initial, { custos: text }))).status, 200);
  assert.equal(h.stored().custos, text);
});

test('widget histórico sem campo de texto reconhecido é preservado e bloqueado', async () => {
  const initial = project();
  initial.estilo.justificativas = { texto_antigo: 'preservar' };
  const h = harness({ initial });
  assert.equal((await h.run(patch(initial))).status, 409);
  assert.deepEqual(h.stored(), initial);
});

test('falha de rollback não informa cancelamento confirmado nem repete a operação', async () => {
  const h = harness({ updateError: true, rollbackError: true });
  const response = await h.run(patch(project()));
  assert.equal(response.status, 500);
  assert.equal(response.body.message, 'Erro ao atualizar o projeto.');
  assert.equal(h.writes.length, 1);
  assert.ok(h.events.includes('rollback-failed'));
  assert.ok(!h.events.includes('commit'));
});
