const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { Jogo } = require('./modelo');
const JOGOS_INICIAIS = require('./jogos-iniciais');

const PORTA = Number(process.env.PORT) || 4002;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/ludoteca';
const AFINIDADES_URL = (process.env.AFINIDADES_URL || 'http://localhost:4003').replace(/\/+$/, '');

const LIMITE_MAXIMO = 100;
const LIMITE_LENTO_MS = 300;

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  const inicio = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    if (ms > LIMITE_LENTO_MS) {
      console.warn(`[lento] ${req.method} ${req.originalUrl} levou ${ms.toFixed(0)} ms (status ${res.statusCode})`);
    }
  });
  next();
});

function lerTexto(valor) {
  if (typeof valor === 'string') return valor.trim();
  if (Array.isArray(valor) && typeof valor[0] === 'string') return valor[0].trim();
  return '';
}

function lerInteiroPositivo(valor) {
  const texto = lerTexto(valor);
  if (!/^\d+$/.test(texto)) return null;
  const numero = Number(texto);
  return numero >= 1 ? numero : null;
}

function lerLimite(valor) {
  const texto = lerTexto(valor);
  if (!/^-?\d+$/.test(texto)) return null;
  return Math.min(Math.max(Number(texto), 1), LIMITE_MAXIMO);
}

function lerIds(valor) {
  const partes = Array.isArray(valor)
    ? valor.filter((item) => typeof item === 'string').join(',')
    : (typeof valor === 'string' ? valor : '');
  const ids = [];
  const vistos = new Set();
  for (const pedaco of partes.split(',')) {
    const id = pedaco.trim().toLowerCase();
    if (!/^[a-f0-9]{24}$/.test(id) || vistos.has(id)) continue;
    vistos.add(id);
    ids.push(id);
    if (ids.length === LIMITE_MAXIMO) break;
  }
  return ids;
}

function escaparRegex(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function limparCorpo(corpo) {
  const { _id, id, criadoEm, __v, ...resto } = corpo;
  return resto;
}

function idValido(id) {
  return mongoose.isValidObjectId(id) && /^[a-f0-9]{24}$/i.test(id);
}

function corpoEhObjeto(corpo) {
  return corpo !== null && typeof corpo === 'object' && !Array.isArray(corpo);
}

function dadosParaOGrafo(jogo) {
  const objeto = jogo.toObject();
  return {
    nome: objeto.nome,
    categoria: objeto.categoria,
    mecanicas: objeto.mecanicas || [],
    designers: objeto.designers || []
  };
}

async function avisarGrafo(metodo, jogoId, corpo) {
  const url = `${AFINIDADES_URL}/grafo/jogos/${encodeURIComponent(jogoId)}`;
  try {
    const opcoes = { method: metodo, signal: AbortSignal.timeout(3000) };
    if (corpo) {
      opcoes.headers = { 'Content-Type': 'application/json' };
      opcoes.body = JSON.stringify(corpo);
    }
    const resposta = await fetch(url, opcoes);
    await resposta.text().catch(() => {});
    if (!resposta.ok) {
      console.warn(`[grafo] ${metodo} ${url} respondeu ${resposta.status}, rode POST /sync no serviço de afinidades depois`);
    }
  } catch (erro) {
    console.warn(`[grafo] não deu pra avisar o serviço de afinidades (${metodo} ${url}): ${erro.message}`);
  }
}

async function buscarPorTexto(filtroBase, termo, limite) {
  let jogos = [];
  try {
    let consulta = Jogo.find({ ...filtroBase, $text: { $search: termo } })
      .sort({ score: { $meta: 'textScore' } });
    if (limite) consulta = consulta.limit(limite);
    jogos = await consulta.lean();
  } catch (erro) {
    if (erro.code !== 27) throw erro;
    console.warn('[busca] índice de texto ausente, usando só a busca por regex');
  }
  if (jogos.length > 0) return jogos;

  const padrao = new RegExp(escaparRegex(termo), 'i');
  let consulta = Jogo.find({
    ...filtroBase,
    $or: [{ nome: padrao }, { mecanicas: padrao }, { designers: padrao }, { tags: padrao }]
  }).sort({ criadoEm: -1 });
  if (limite) consulta = consulta.limit(limite);
  return consulta.lean();
}

app.get('/jogos', async (req, res, next) => {
  try {
    if (req.query.ids !== undefined) {
      const ids = lerIds(req.query.ids);
      if (ids.length === 0) return res.json([]);
      const encontrados = await Jogo.find({ _id: { $in: ids } }).lean();
      const porId = new Map(encontrados.map((jogo) => [String(jogo._id), jogo]));
      return res.json(ids.map((id) => porId.get(id)).filter(Boolean));
    }

    const filtro = {};

    const categoria = lerTexto(req.query.categoria);
    if (categoria) filtro.categoria = categoria;

    const qtdJogadores = lerInteiroPositivo(req.query.jogadores);
    if (qtdJogadores !== null) {
      filtro['jogadores.min'] = { $lte: qtdJogadores };
      filtro['jogadores.max'] = { $gte: qtdJogadores };
    }

    const limite = lerLimite(req.query.limite);
    const termo = lerTexto(req.query.q);

    if (termo) {
      return res.json(await buscarPorTexto(filtro, termo, limite));
    }

    let consulta = Jogo.find(filtro).sort({ criadoEm: -1 });
    if (limite) consulta = consulta.limit(limite);
    res.json(await consulta.lean());
  } catch (erro) {
    next(erro);
  }
});

app.get('/jogos/:id', async (req, res, next) => {
  try {
    if (!idValido(req.params.id)) {
      return res.status(404).json({ erro: 'Jogo não encontrado' });
    }
    const jogo = await Jogo.findById(req.params.id).lean();
    if (!jogo) return res.status(404).json({ erro: 'Jogo não encontrado' });
    res.json(jogo);
  } catch (erro) {
    next(erro);
  }
});

app.post('/jogos', async (req, res, next) => {
  try {
    if (!corpoEhObjeto(req.body)) {
      return res.status(400).json({ erro: 'Envie os dados do jogo como um objeto JSON' });
    }
    const jogo = new Jogo(limparCorpo(req.body));
    await jogo.save();
    await avisarGrafo('PUT', String(jogo._id), dadosParaOGrafo(jogo));
    res.status(201).json(jogo);
  } catch (erro) {
    next(erro);
  }
});

app.put('/jogos/:id', async (req, res, next) => {
  try {
    if (!idValido(req.params.id)) {
      return res.status(404).json({ erro: 'Jogo não encontrado' });
    }
    if (!corpoEhObjeto(req.body)) {
      return res.status(400).json({ erro: 'Envie os dados do jogo como um objeto JSON' });
    }
    const jogo = await Jogo.findById(req.params.id);
    if (!jogo) return res.status(404).json({ erro: 'Jogo não encontrado' });

    jogo.set(limparCorpo(req.body));
    await jogo.save();
    await avisarGrafo('PUT', String(jogo._id), dadosParaOGrafo(jogo));
    res.json(jogo);
  } catch (erro) {
    next(erro);
  }
});

app.delete('/jogos/:id', async (req, res, next) => {
  try {
    if (!idValido(req.params.id)) {
      return res.status(404).json({ erro: 'Jogo não encontrado' });
    }
    const id = req.params.id.toLowerCase();
    const resultado = await Jogo.deleteOne({ _id: id });
    if (resultado.deletedCount === 0) {
      return res.status(404).json({ erro: 'Jogo não encontrado' });
    }
    await avisarGrafo('DELETE', id);
    res.json({ mensagem: 'Jogo removido do acervo' });
  } catch (erro) {
    next(erro);
  }
});

app.get('/estatisticas', async (req, res, next) => {
  try {
    const grupos = await Jogo.aggregate([
      { $group: { _id: '$categoria', total: { $sum: 1 } } },
      { $sort: { total: -1, _id: 1 } }
    ]);
    const porCategoria = grupos.map((grupo) => ({
      categoria: grupo._id ?? 'Sem categoria',
      total: grupo.total
    }));
    const total = porCategoria.reduce((soma, item) => soma + item.total, 0);
    res.json({ total, porCategoria });
  } catch (erro) {
    next(erro);
  }
});

app.get('/saude', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, banco: 'mongodb', erro: 'Sem conexão com o MongoDB' });
    }
    await mongoose.connection.db.admin().ping();
    res.json({ ok: true, banco: 'mongodb' });
  } catch (erro) {
    res.status(503).json({ ok: false, banco: 'mongodb', erro: erro.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ erro: `Rota não encontrada: ${req.method} ${req.path}` });
});

app.use((erro, req, res, next) => {
  if (erro.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido' });
  }

  if (erro instanceof mongoose.Error.ValidationError) {
    const mensagens = new Set();
    for (const detalhe of Object.values(erro.errors)) {
      if (detalhe instanceof mongoose.Error.ValidationError) continue;
      mensagens.add(detalhe instanceof mongoose.Error.CastError
        ? `Valor inválido para o campo "${detalhe.path}"`
        : detalhe.message);
    }
    return res.status(400).json({ erro: [...mensagens].join('; ') || 'Dados do jogo inválidos' });
  }

  if (erro instanceof mongoose.Error.CastError) {
    return res.status(400).json({ erro: `Valor inválido para o campo "${erro.path}"` });
  }

  if (erro instanceof mongoose.Error.VersionError) {
    return res.status(409).json({ erro: 'Esse jogo foi alterado ao mesmo tempo por outra pessoa. Recarregue e tente de novo.' });
  }

  const status = erro.status || erro.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ erro: 'Requisição inválida' });
  }

  console.error('[erro]', req.method, req.originalUrl, erro);
  res.status(500).json({ erro: 'Erro interno no serviço do acervo' });
});

let servidor = null;

async function popularSeVazio() {
  const total = await Jogo.estimatedDocumentCount();
  if (total > 0) return false;
  const agora = Date.now();
  const documentos = JOGOS_INICIAIS.map((jogo, i) => ({ ...jogo, criadoEm: new Date(agora - i * 60 * 1000) }));
  await Jogo.insertMany(documentos);
  console.log(`[acervo] acervo vazio, ${documentos.length} jogos iniciais cadastrados`);
  return true;
}

async function sincronizarGrafo(tentativas = 40) {
  for (let i = 1; i <= tentativas; i++) {
    const resposta = await fetch(`${AFINIDADES_URL}/sync`, { method: 'POST', signal: AbortSignal.timeout(30000) })
      .catch(() => null);
    if (resposta && resposta.ok) {
      console.log('[acervo] grafo montado no Neo4j');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.warn('[acervo] não deu pra montar o grafo, use o botão "Reconstruir grafo" no monitor');
}

async function iniciar() {
  try {
    await mongoose.connect(MONGO_URL, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
    console.log('[acervo] conectado ao MongoDB');
    mongoose.connection.on('disconnected', () => console.warn('[acervo] conexão com o MongoDB caiu, o driver vai tentar reconectar'));
    mongoose.connection.on('reconnected', () => console.log('[acervo] reconectado ao MongoDB'));

    const removidos = await Jogo.syncIndexes();
    if (removidos.length > 0) console.log('[acervo] índices antigos removidos:', removidos.join(', '));
    console.log('[acervo] índices conferidos');

    const populou = await popularSeVazio();

    servidor = app.listen(PORTA, () => {
      console.log(`[acervo] API ouvindo na porta ${PORTA} (grafo em ${AFINIDADES_URL})`);
      if (populou) sincronizarGrafo();
    });
    servidor.on('error', (erro) => {
      console.error('[acervo] não consegui abrir a porta', PORTA, '-', erro.message);
      process.exit(1);
    });
  } catch (erro) {
    console.error('[acervo] falha ao iniciar:', erro.message);
    process.exit(1);
  }
}

async function encerrar(sinal) {
  console.log(`[acervo] recebi ${sinal}, encerrando...`);
  try {
    if (servidor) await new Promise((resolve) => servidor.close(resolve));
    await mongoose.disconnect();
  } catch (erro) {
    console.error('[acervo] erro ao encerrar:', erro.message);
  } finally {
    process.exit(0);
  }
}

if (require.main === module) {
  process.on('SIGTERM', () => encerrar('SIGTERM'));
  process.on('SIGINT', () => encerrar('SIGINT'));

  process.on('unhandledRejection', (motivo) => {
    console.error('[acervo] promise rejeitada sem tratamento:', motivo);
  });

  iniciar();
}

module.exports = app;
