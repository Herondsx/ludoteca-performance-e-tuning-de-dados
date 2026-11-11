// servico-acervo — o catálogo de jogos da Ludoteca
// banco: MongoDB (porta 4002)
//
// Esse serviço é o "dono" dos jogos: nome, ficha técnica, mecânicas,
// expansões, como jogar... Os outros dois serviços só guardam o ID do jogo
// (o PostgreSQL pra favoritos/visualizações, o Neo4j pros vínculos de
// similaridade) e vêm aqui quando precisam do resto.
//
// Sempre que um jogo é criado, editado ou removido, a gente avisa o serviço de
// afinidades (Neo4j) pra ele manter o grafo em dia. Esse aviso é "dispara e
// esquece": se o Neo4j estiver fora do ar, o cadastro no acervo funciona do
// mesmo jeito e o grafo pode ser reconstruído depois com POST /sync.

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { Jogo } = require('./modelo');

const PORTA = Number(process.env.PORT) || 4002;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/ludoteca';
const AFINIDADES_URL = (process.env.AFINIDADES_URL || 'http://localhost:4003').replace(/\/+$/, '');

// teto da listagem e do lote de ids — protege o banco (e a rede) de alguém
// pedindo o catálogo inteiro mil vezes por segundo com ?limite=999999
const LIMITE_MAXIMO = 100;
// requisição que passar disso vira um aviso no log. É um "slow log" caseiro:
// ajuda a perceber na hora da demo quando falta índice em alguma consulta
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

// ---------------------------------------------------------------------------
// funções auxiliares
// ---------------------------------------------------------------------------

// O Express (via "qs") transforma ?categoria[$ne]=x num OBJETO. Se esse objeto
// fosse direto pro filtro do Mongo, viraria operador e abriria brecha de
// injeção NoSQL. Por isso todo parâmetro de query passa por aqui e só texto
// puro sobrevive.
function lerTexto(valor) {
  if (typeof valor === 'string') return valor.trim();
  if (Array.isArray(valor) && typeof valor[0] === 'string') return valor[0].trim();
  return '';
}

// inteiro positivo ou null (null = "não filtra")
function lerInteiroPositivo(valor) {
  const texto = lerTexto(valor);
  if (!/^\d+$/.test(texto)) return null;
  const numero = Number(texto);
  return numero >= 1 ? numero : null;
}

// ?limite= opcional. Sem ele a lista vem completa (o serviço de afinidades
// depende disso pra reconstruir o grafo). Com ele, fica preso entre 1 e 100.
function lerLimite(valor) {
  const texto = lerTexto(valor);
  if (!/^-?\d+$/.test(texto)) return null;
  return Math.min(Math.max(Number(texto), 1), LIMITE_MAXIMO);
}

// ?ids=a,b,c -> só ObjectIds válidos (24 hex), em minúsculo, sem repetidos,
// no máximo 100. Aceita também ?ids=a&ids=b. Em minúsculo porque é assim que
// o ObjectId volta do banco, e a gente precisa casar um com o outro depois
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

// escapa os caracteres especiais de regex. Sem isso, buscar "c++" ou "(" faria
// o RegExp explodir, e alguém mal-intencionado poderia mandar um padrão
// gigante e catastrófico pra travar o servidor (ReDoS)
function escaparRegex(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// o que vem no corpo e NÃO pode ser escrito pelo cliente: o _id (quem decide é
// o Mongo), a data de criação, a versão interna do Mongoose e o "id" (que no
// Mongoose 8 é um apelido do _id e trocaria a chave do documento)
function limparCorpo(corpo) {
  const { _id, id, criadoEm, __v, ...resto } = corpo;
  return resto;
}

// id de rota válido. O isValidObjectId sozinho aceita QUALQUER texto de 12
// caracteres (porque 12 bytes também viram ObjectId), então "abcdefghijkl"
// passaria. Exigindo também os 24 hexadecimais, só ObjectId de verdade entra.
function idValido(id) {
  return mongoose.isValidObjectId(id) && /^[a-f0-9]{24}$/i.test(id);
}

function corpoEhObjeto(corpo) {
  return corpo !== null && typeof corpo === 'object' && !Array.isArray(corpo);
}

// só o que interessa pro grafo: o Neo4j não precisa de descrição, regras etc.
function dadosParaOGrafo(jogo) {
  const objeto = jogo.toObject();
  return {
    nome: objeto.nome,
    categoria: objeto.categoria,
    mecanicas: objeto.mecanicas || [],
    designers: objeto.designers || []
  };
}

// Aviso ao serviço de afinidades. As rotas esperam (await) esse aviso antes de
// responder, pra que o grafo já esteja atualizado quando o frontend pedir os
// "jogos parecidos". O try/catch envolve tudo, então essa promise nunca rejeita:
// se o Neo4j estiver fora, só fica um aviso no log e o acervo segue funcionando.
// O timeout de 3 s garante que a resposta nunca fica presa esperando o grafo.
async function avisarGrafo(metodo, jogoId, corpo) {
  const url = `${AFINIDADES_URL}/grafo/jogos/${encodeURIComponent(jogoId)}`;
  try {
    const opcoes = { method: metodo, signal: AbortSignal.timeout(3000) };
    if (corpo) {
      opcoes.headers = { 'Content-Type': 'application/json' };
      opcoes.body = JSON.stringify(corpo);
    }
    const resposta = await fetch(url, opcoes);
    // lê o corpo mesmo sem usar, pra conexão voltar pro pool do fetch
    await resposta.text().catch(() => {});
    if (!resposta.ok) {
      console.warn(`[grafo] ${metodo} ${url} respondeu ${resposta.status} — rode POST /sync no serviço de afinidades depois`);
    }
  } catch (erro) {
    console.warn(`[grafo] não deu pra avisar o serviço de afinidades (${metodo} ${url}): ${erro.message}`);
  }
}

// busca por texto em duas etapas:
//  1ª) $text, que usa o índice "busca_textual" e ordena por relevância
//  2ª) se não achar nada, regex case-insensitive em nome/mecânicas/designers/tags.
// O fallback existe porque o $text casa PALAVRAS inteiras (com stemming):
// buscar "Pand" não acha "Pandemic". A regex acha pedaço de palavra, mas não
// aproveita índice (é varredura), então só roda quando a primeira tentativa falha.
async function buscarPorTexto(filtroBase, termo, limite) {
  let jogos = [];
  try {
    let consulta = Jogo.find({ ...filtroBase, $text: { $search: termo } })
      .sort({ score: { $meta: 'textScore' } });
    if (limite) consulta = consulta.limit(limite);
    jogos = await consulta.lean();
  } catch (erro) {
    // código 27 = índice de texto não existe (ex.: alguém apagou na mão).
    // Em vez de quebrar a tela de busca, cai direto na regex
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

// ---------------------------------------------------------------------------
// rotas
// ---------------------------------------------------------------------------

// GET /jogos — listagem com busca, filtros e consulta em lote por ids.
// Todas as leituras usam .lean(): o Mongoose devolve objeto JS puro em vez de
// um "documento turbinado" (com getters, setters, controle de alteração...).
// Pra só mandar JSON de volta isso é bem mais leve em CPU e memória.
app.get('/jogos', async (req, res, next) => {
  try {
    // modo "lote": o frontend tem uma lista de ids (ranking, favoritos,
    // histórico) e quer os jogos de uma vez. Uma ida ao banco com $in em vez
    // de N chamadas GET /jogos/:id — é o clássico problema do N+1 resolvido.
    if (req.query.ids !== undefined) {
      const ids = lerIds(req.query.ids);
      if (ids.length === 0) return res.json([]);
      const encontrados = await Jogo.find({ _id: { $in: ids } }).lean();
      // o $in não garante ordem nenhuma, então reordena aqui seguindo a
      // ordem pedida (que no ranking é justamente a posição!). Id que não
      // existe mais no acervo simplesmente some da resposta.
      const porId = new Map(encontrados.map((jogo) => [String(jogo._id), jogo]));
      return res.json(ids.map((id) => porId.get(id)).filter(Boolean));
    }

    const filtro = {};

    const categoria = lerTexto(req.query.categoria);
    if (categoria) filtro.categoria = categoria;

    // "jogo para n pessoas" = n cabe dentro da faixa [min, max] do jogo
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

    // sem busca: mais novos primeiro. Quando tem categoria no filtro, o índice
    // { categoria: 1, criadoEm: -1 } entrega tudo já ordenado
    let consulta = Jogo.find(filtro).sort({ criadoEm: -1 });
    if (limite) consulta = consulta.limit(limite);
    res.json(await consulta.lean());
  } catch (erro) {
    next(erro);
  }
});

// GET /jogos/:id — ficha completa de um jogo
app.get('/jogos/:id', async (req, res, next) => {
  try {
    // id que nem tem formato de ObjectId não tem como existir: responde 404
    // direto, sem gastar uma consulta (e sem estourar um CastError)
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

// POST /jogos — cadastra um jogo novo
app.post('/jogos', async (req, res, next) => {
  try {
    if (!corpoEhObjeto(req.body)) {
      return res.status(400).json({ erro: 'Envie os dados do jogo como um objeto JSON' });
    }
    const jogo = new Jogo(limparCorpo(req.body));
    await jogo.save();
    // avisa o grafo ANTES de responder: assim, quando o frontend abrir a ficha
    // logo em seguida, os "jogos parecidos" já enxergam o jogo novo no Neo4j.
    // O avisarGrafo nunca lança erro e tem timeout curto, então se o Neo4j
    // estiver fora o cadastro continua funcionando normalmente
    await avisarGrafo('PUT', String(jogo._id), dadosParaOGrafo(jogo));
    res.status(201).json(jogo);
  } catch (erro) {
    next(erro);
  }
});

// PUT /jogos/:id — edita um jogo
// Poderia ser um findByIdAndUpdate numa linha só, mas aí o Mongoose roda só os
// validators de campo (e com algumas limitações), e o nosso pre('validate')
// — que limpa as listas e confere max >= min — ficaria de fora. Buscando o
// documento, aplicando as mudanças com set() e chamando save(), a validação
// completa roda igualzinho ao cadastro. Custa uma leitura a mais, mas edição é
// rara perto de leitura, então vale a troca.
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
    // o save() só manda pro banco os campos que realmente mudaram ($set parcial)
    await jogo.save();
    await avisarGrafo('PUT', String(jogo._id), dadosParaOGrafo(jogo));
    res.json(jogo);
  } catch (erro) {
    next(erro);
  }
});

// DELETE /jogos/:id — tira o jogo do acervo
app.delete('/jogos/:id', async (req, res, next) => {
  try {
    if (!idValido(req.params.id)) {
      return res.status(404).json({ erro: 'Jogo não encontrado' });
    }
    // deleteOne em vez de findByIdAndDelete: a gente não precisa do documento
    // apagado de volta, só saber se apagou algo. Menos dado trafegando.
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

// GET /estatisticas — total e contagem por categoria (usado pelo monitor)
// O agrupamento roda DENTRO do Mongo (aggregation pipeline): volta só uma
// linha por categoria, em vez de trazer todos os jogos pro Node pra contar.
// O total sai da soma dos grupos, então é uma consulta só, não duas.
app.get('/estatisticas', async (req, res, next) => {
  try {
    const grupos = await Jogo.aggregate([
      { $group: { _id: '$categoria', total: { $sum: 1 } } },
      // desempate pelo nome só pra ordem ficar estável entre uma atualização
      // e outra do monitor (senão categorias empatadas ficam trocando de lugar)
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

// GET /saude — o monitor chama isso a cada poucos segundos
app.get('/saude', async (req, res) => {
  try {
    // readyState 1 = conectado. Se a conexão já caiu, responde 503 na hora em
    // vez de deixar o ping pendurado esperando o driver desistir
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, banco: 'mongodb', erro: 'Sem conexão com o MongoDB' });
    }
    await mongoose.connection.db.admin().ping();
    res.json({ ok: true, banco: 'mongodb' });
  } catch (erro) {
    res.status(503).json({ ok: false, banco: 'mongodb', erro: erro.message });
  }
});

// rota que não existe -> 404 em JSON (e não a página HTML padrão do Express)
app.use((req, res) => {
  res.status(404).json({ erro: `Rota não encontrada: ${req.method} ${req.path}` });
});

// tratador de erro central: todas as rotas fazem next(erro) e a tradução pra
// status HTTP fica concentrada aqui
// eslint-disable-next-line no-unused-vars
app.use((erro, req, res, next) => {
  // corpo que não é JSON válido (vem do express.json)
  if (erro.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido' });
  }

  // erro de validação do schema: junta as mensagens de todos os campos
  if (erro instanceof mongoose.Error.ValidationError) {
    // (o Set tira mensagem repetida, ex.: duas expansões sem nome)
    const mensagens = new Set();
    for (const detalhe of Object.values(erro.errors)) {
      // erro de subdocumento aparece duas vezes: um "resumão" no campo pai
      // (expansoes) e o detalhe no campo filho (expansoes.0.nome). Fica só o detalhe
      if (detalhe instanceof mongoose.Error.ValidationError) continue;
      mensagens.add(detalhe instanceof mongoose.Error.CastError
        ? `Valor inválido para o campo "${detalhe.path}"`
        : detalhe.message);
    }
    return res.status(400).json({ erro: [...mensagens].join('; ') || 'Dados do jogo inválidos' });
  }

  // tipo errado fora da validação (ex.: um campo que o Mongo não consegue converter)
  if (erro instanceof mongoose.Error.CastError) {
    return res.status(400).json({ erro: `Valor inválido para o campo "${erro.path}"` });
  }

  // duas edições do mesmo jogo ao mesmo tempo mexendo nas mesmas listas
  if (erro instanceof mongoose.Error.VersionError) {
    return res.status(409).json({ erro: 'Esse jogo foi alterado ao mesmo tempo por outra pessoa. Recarregue e tente de novo.' });
  }

  // outros erros "do cliente" que o Express já marca com status 4xx
  // (ex.: corpo grande demais = 413)
  const status = erro.status || erro.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ erro: 'Requisição inválida' });
  }

  console.error('[erro]', req.method, req.originalUrl, erro);
  res.status(500).json({ erro: 'Erro interno no serviço do acervo' });
});

// ---------------------------------------------------------------------------
// inicialização
// ---------------------------------------------------------------------------

let servidor = null;

async function iniciar() {
  try {
    // autoIndex desligado: por padrão o Mongoose dispara a criação dos índices
    // sozinho, em segundo plano, quando o model é compilado. Aqui a gente
    // prefere controlar isso explicitamente com syncIndexes() logo abaixo.
    // serverSelectionTimeoutMS curto pra falhar rápido se o Mongo não estiver
    // de pé (o compose reinicia o container e tenta de novo).
    await mongoose.connect(MONGO_URL, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
    console.log('[acervo] conectado ao MongoDB');
    // listeners registrados só depois da primeira conexão dar certo; antes
    // disso, uma falha já cai no catch e derruba o processo de qualquer jeito
    mongoose.connection.on('disconnected', () => console.warn('[acervo] conexão com o MongoDB caiu, o driver vai tentar reconectar'));
    mongoose.connection.on('reconnected', () => console.log('[acervo] reconectado ao MongoDB'));

    // syncIndexes deixa os índices do banco IGUAIS aos declarados no modelo:
    // cria os que faltam e remove os que não estão mais no código. Assim se
    // alguém mudar um peso do índice de texto, por exemplo, o banco acompanha.
    const removidos = await Jogo.syncIndexes();
    if (removidos.length > 0) console.log('[acervo] índices antigos removidos:', removidos.join(', '));
    console.log('[acervo] índices conferidos');

    servidor = app.listen(PORTA, () => {
      console.log(`[acervo] API ouvindo na porta ${PORTA} (grafo em ${AFINIDADES_URL})`);
    });
    // porta ocupada e afins: sai com erro claro em vez de uma exceção solta
    servidor.on('error', (erro) => {
      console.error('[acervo] não consegui abrir a porta', PORTA, '-', erro.message);
      process.exit(1);
    });
  } catch (erro) {
    console.error('[acervo] falha ao iniciar:', erro.message);
    process.exit(1);
  }
}

// docker compose stop manda SIGTERM: fecha o servidor HTTP e a conexão com o
// banco direitinho, em vez de esperar o Docker matar o processo na marra
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

// só sobe o servidor quando o arquivo é executado direto (node index.js).
// Se alguém der require (ex.: um teste), recebe o app sem conectar em nada.
if (require.main === module) {
  process.on('SIGTERM', () => encerrar('SIGTERM'));
  process.on('SIGINT', () => encerrar('SIGINT'));

  // rede de segurança: se alguma promise escapar sem catch, loga em vez de sumir calada
  process.on('unhandledRejection', (motivo) => {
    console.error('[acervo] promise rejeitada sem tratamento:', motivo);
  });

  iniciar();
}

module.exports = app;
