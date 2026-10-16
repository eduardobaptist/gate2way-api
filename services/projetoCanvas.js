const { createHash } = require('node:crypto');

const CAMPOS_CANVAS = Object.freeze([
  'justificativas', 'objsmart', 'beneficios', 'produto', 'requisitos',
  'stakeholders', 'equipe', 'premissas', 'grupo_de_entrega', 'restricoes',
  'riscos', 'linha_do_tempo', 'custos',
]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

class CanvasError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Preserve types, absent properties and opaque strings; never normalize stored data.
function canonical(value) {
  if (value === undefined) return ['absent'];
  if (value === null) return ['null'];
  if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
  if (typeof value === 'number' && Number.isFinite(value)) return ['number', value];
  if (Array.isArray(value)) return ['array', value.map(canonical)];
  if (record(value)) return ['object', Object.keys(value).sort().map(key => [key, canonical(value[key])])];
  throw new CanvasError(409, 'CANVAS_UNSUPPORTED', 'Canvas não pode ser interpretado com segurança.');
}

function revision(projeto) {
  const snapshot = [String(projeto.id), projeto.estilo, ...CAMPOS_CANVAS.map(key => projeto[key])];
  return createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex');
}

function decoded(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function equal(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function parsePatch(value) {
  let patch = value;
  if (typeof patch === 'string') {
    try { patch = JSON.parse(patch); } catch {
      throw new CanvasError(400, 'CANVAS_INVALID_PATCH', 'canvas_patch deve conter JSON válido.');
    }
  }
  if (!record(patch) || Object.keys(patch).some(key => !['set', 'clear'].includes(key)) ||
      (own(patch, 'set') && !record(patch.set)) ||
      (own(patch, 'clear') && !Array.isArray(patch.clear))) {
    throw new CanvasError(400, 'CANVAS_INVALID_PATCH', 'Estrutura de canvas_patch inválida.');
  }
  const set = patch.set || {};
  const clear = patch.clear || [];
  const keys = [...Object.keys(set), ...clear];
  if (!keys.length || keys.some(key => !CAMPOS_CANVAS.includes(key)) || new Set(keys).size !== keys.length ||
      Object.values(set).some(value => typeof value !== 'string' || !value.length || Array.from(value).length > 255)) {
    throw new CanvasError(400, 'CANVAS_INVALID_PATCH', 'Use set para textos de até 255 caracteres e clear para limpeza explícita.');
  }
  return Object.fromEntries([...Object.entries(set), ...clear.map(key => [key, ''])]);
}

function updates(projeto, body) {
  const legacy = ['estilo', ...CAMPOS_CANVAS].filter(key => own(body, key));
  if (own(body, 'canvas_patch') && legacy.length) {
    throw new CanvasError(400, 'CANVAS_MIXED_CONTRACT', 'Não combine canvas_patch com os campos legados do Canvas.');
  }
  if (!own(body, 'canvas_patch')) {
    // An old client may echo unchanged data, but must not replace the snapshot.
    for (const key of legacy) {
      const unchanged = key === 'estilo'
        ? equal(decoded(body[key]), decoded(projeto[key]))
        : equal(body[key], projeto[key]);
      if (!unchanged) throw new CanvasError(428, 'CANVAS_PRECONDITION_REQUIRED',
        'Atualize o cliente: alterações do Canvas exigem canvas_patch e canvas_revision.');
    }
    return {};
  }

  const changes = parsePatch(body.canvas_patch);
  if (typeof body.canvas_revision !== 'string' || body.canvas_revision.length !== 64 || !/^[a-f0-9]{64}$/.test(body.canvas_revision)) {
    throw new CanvasError(428, 'CANVAS_PRECONDITION_REQUIRED', 'Informe a revisão original do Canvas.');
  }
  if (body.canvas_revision !== revision(projeto)) {
    throw new CanvasError(409, 'CANVAS_CONFLICT', 'O Canvas foi alterado. Recarregue o projeto antes de editar.');
  }

  // Only the targeted text changes. Keep all geometry, other widgets and metadata.
  const raw = projeto.estilo;
  const style = raw == null ? {} : decoded(raw);
  if (!record(style)) throw new CanvasError(409, 'CANVAS_UNSUPPORTED',
    'Formato legado não reconhecido. O Canvas foi preservado.');
  if (Object.keys(style).length && !CAMPOS_CANVAS.some(key =>
    own(style, key) && record(style[key]) && own(style[key], 'textarea_value'))) {
    throw new CanvasError(409, 'CANVAS_UNSUPPORTED', 'Estrutura histórica não reconhecida. O Canvas foi preservado.');
  }
  const next = { ...style };
  for (const [key, text] of Object.entries(changes)) {
    const widget = own(style, key) ? style[key] : undefined;
    if (widget !== undefined && (!record(widget) || !own(widget, 'textarea_value') ||
        (own(widget, 'textarea_value') && widget.textarea_value !== null && typeof widget.textarea_value !== 'string'))) {
      throw new CanvasError(409, 'CANVAS_UNSUPPORTED', 'Campo legado não reconhecido. O Canvas foi preservado.');
    }
    if (widget && own(widget, 'textarea_value') && projeto[key] != null &&
        widget.textarea_value !== projeto[key]) {
      throw new CanvasError(409, 'CANVAS_DIVERGENT', 'Representações divergentes do Canvas precisam de revisão.');
    }
    next[key] = { ...widget, textarea_value: text };
  }
  // The existing model accepts a string; do not change its type or double-parse.
  let serialized;
  try {
    canonical(next);
    serialized = JSON.stringify(next);
    if (!equal(JSON.parse(serialized), next)) throw new Error('Conversão com perda');
  } catch {
    throw new CanvasError(409, 'CANVAS_UNSUPPORTED', 'Não foi possível serializar o Canvas sem perda.');
  }
  return { ...changes, estilo: serialized };
}

function verifyPersistence(expected, persisted, styleChanged) {
  const styleMatches = styleChanged
    ? equal(decoded(expected.estilo), decoded(persisted.estilo))
    : equal(expected.estilo, persisted.estilo);
  if (!styleMatches || CAMPOS_CANVAS.some(key => !equal(expected[key], persisted[key]))) {
    throw new CanvasError(409, 'CANVAS_PERSISTENCE_MISMATCH',
      'A persistência não preservou o Canvas esperado. A atualização foi rejeitada.');
  }
}

function storageValue(raw, current, serialized) {
  // Inspect the JSON text too: the driver can round historical numeric values
  // before delivering an object. Never rewrite such values through JSON.parse.
  if (raw !== null && typeof raw !== 'string') {
    throw new CanvasError(409, 'CANVAS_UNSUPPORTED', 'Representação persistida não reconhecida.');
  }
  let stored;
  try { stored = raw === null ? null : JSON.parse(raw); } catch {
    throw new CanvasError(409, 'CANVAS_UNSUPPORTED', 'Representação persistida não reconhecida.');
  }
  if (!(stored == null && current == null) && !equal(decoded(stored), decoded(current))) {
    throw new CanvasError(409, 'CANVAS_STORAGE_MISMATCH', 'Representações de leitura divergentes.');
  }
  const source = typeof stored === 'string' ? stored : raw;
  if (source !== null) {
    const tokens = source.match(/"(?:\\[\s\S]|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,]/g) || [];
    if (tokens.some(token => /^[-0-9]/.test(token) &&
        (JSON.stringify(Number(token)) !== token ||
         (Number.isInteger(Number(token)) && !Number.isSafeInteger(Number(token)))))) {
      throw new CanvasError(409, 'CANVAS_UNSUPPORTED', 'Conteúdo numérico legado exige preservação sem conversão.');
    }
    // JSON.parse silently discards duplicate keys in historical JSON strings.
    // Inspect the valid JSON token stream before permitting a rewrite.
    const stack = [];
    tokens.forEach((token, index) => {
      if (token === '{') stack.push(new Set());
      else if (token === '[') stack.push(null);
      else if (token === '}' || token === ']') stack.pop();
      else if (token[0] === '"' && tokens[index + 1] === ':') {
        const keys = stack[stack.length - 1];
        const key = JSON.parse(token);
        if (keys.has(key)) throw new CanvasError(409, 'CANVAS_UNSUPPORTED',
          'Conteúdo legado com propriedades duplicadas exige revisão.');
        keys.add(key);
      }
    });
  }
  // Preserve a JSON string stored inside the JSON column as a JSON string;
  // do not silently convert it into a JSON object (or encode it twice).
  return typeof stored === 'string' ? JSON.stringify(serialized) : serialized;
}

module.exports = { CAMPOS_CANVAS, CanvasError, revision, updates, verifyPersistence, storageValue };
