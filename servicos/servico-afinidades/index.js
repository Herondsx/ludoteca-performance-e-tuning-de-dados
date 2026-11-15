const express = require('express');
const cors = require('cors');
const neo4j = require('neo4j-driver');

const PORTA = Number(process.env.PORT) || 4003;
const NEO4J_URL = process.env.NEO4J_URL || 'bolt://localhost:7687';
const NEO4J_USUARIO = process.env.NEO4J_USUARIO || 'neo4j';
const NEO4J_SENHA = process.env.NEO4J_SENHA || 'ludoteca123';
const ACERVO_URL = (process.env.ACERVO_URL || 'http://localhost:4002').replace(/\/+$/, '');

const TENTATIVAS_CONEXAO = 30;
const ESPERA_ENTRE_TENTATIVAS_MS = 2000;
const TEMPO_MAXIMO_ACERVO_MS = 10000;

const driver = neo4j.driver(NEO4J_URL, neo4j.auth.basic(NEO4J_USUARIO, NEO4J_SENHA), {
  disableLosslessIntegers: true
});

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

function normalizarMecanica(valor) {
  return typeof valor === 'string' ? valor.trim().toLowerCase() : '';
}

function normalizarDesigner(valor) {
  return typeof valor === 'string' ? valor.trim() : '';
}

function normalizarLista(lista, normalizar) {
  if (!Array.isArray(lista)) return [];
  return [...new Set(lista.map(normalizar).filter(Boolean))];
}

function ordenarTextos(lista) {
  return [...(lista || [])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function inteiroEntre(valor, padrao, minimo, maximo) {
  const numero = Number.parseInt(valor, 10);
  if (Number.isNaN(numero)) return padrao;
  return Math.min(maximo, Math.max(minimo, numero));
}

function esperar(ms) {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

class ErroAcervo extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroAcervo';
  }
}

async function lerGrafo(trabalho) {
  const sessao = driver.session();
  try {
    return await sessao.executeRead(trabalho);
  } finally {
    await sessao.close();
  }
}

async function escreverGrafo(trabalho) {
  const sessao = driver.session();
  try {
    return await sessao.executeWrite(trabalho);
  } finally {
    await sessao.close();
  }
}

function responderErro(res, erro, acao) {
  const codigo = (erro && erro.code) || '';
  const indisponivel =
    codigo === neo4j.error.SERVICE_UNAVAILABLE ||
    codigo === neo4j.error.SESSION_EXPIRED ||
    codigo.startsWith('Neo.TransientError');

  console.error(`[afinidades] falha ao ${acao}:`, codigo, erro && erro.message);
  if (res.headersSent) return;

  if (indisponivel) {
    return res.status(503).json({ erro: 'O Neo4j está indisponível agora, tente de novo em instantes' });
  }
  return res.status(500).json({ erro: `Não foi possível ${acao}` });
}

async function contarGrafo(tx) {
  const resultado = await tx.run(`
    RETURN COUNT { MATCH (j:Jogo) RETURN j } AS jogos,
           COUNT { MATCH (m:Mecanica) RETURN m } AS mecanicas,
           COUNT { MATCH (d:Designer) RETURN d } AS designers,
           COUNT { MATCH (:Jogo)-[r:USA_MECANICA|CRIADO_POR]->() RETURN r } AS relacoes
  `);
  const registro = resultado.records[0];
  return {
    jogos: registro.get('jogos'),
    mecanicas: registro.get('mecanicas'),
    designers: registro.get('designers'),
    relacoes: registro.get('relacoes')
  };
}

async function limparOrfaos(tx) {
  const resultado = await tx.run(`
    MATCH (n:Mecanica|Designer)
    WHERE NOT (n)--()
    DELETE n
    RETURN count(*) AS removidos
  `);
  return resultado.records[0].get('removidos');
}

async function buscarJogosDoAcervo() {
  let resposta;
  try {
    resposta = await fetch(`${ACERVO_URL}/jogos?limite=100`, {
      signal: AbortSignal.timeout(TEMPO_MAXIMO_ACERVO_MS)
    });
  } catch (erro) {
    throw new ErroAcervo(`Acervo inacessível em ${ACERVO_URL} (${erro.message})`);
  }

  if (!resposta.ok) {
    throw new ErroAcervo(`O acervo respondeu com status ${resposta.status}`);
  }

  let lista;
  try {
    lista = await resposta.json();
  } catch {
    throw new ErroAcervo('O acervo devolveu uma resposta que não é JSON');
  }
  if (!Array.isArray(lista)) {
    throw new ErroAcervo('O acervo não devolveu uma lista de jogos');
  }

  const porId = new Map();
  for (const jogo of lista) {
    if (!jogo || typeof jogo !== 'object') continue;
    const id = jogo._id || jogo.id;
    const nome = typeof jogo.nome === 'string' ? jogo.nome.trim() : '';
    if (!id || !nome) continue;

    porId.set(String(id), {
      id: String(id),
      nome,
      categoria: typeof jogo.categoria === 'string' && jogo.categoria.trim() ? jogo.categoria.trim() : 'Outros',
      mecanicas: normalizarLista(jogo.mecanicas, normalizarMecanica),
      designers: normalizarLista(jogo.designers, normalizarDesigner)
    });
  }
  return [...porId.values()];
}

async function executarSincronizacao() {
  const jogos = await buscarJogosDoAcervo();

  return escreverGrafo(async (tx) => {
    await tx.run('MATCH (n:Jogo|Mecanica|Designer) DETACH DELETE n');

    await tx.run(
      `UNWIND $jogos AS j
       MERGE (g:Jogo {id: j.id})
       SET g.nome = j.nome, g.categoria = j.categoria
       WITH g, j
       UNWIND j.mecanicas AS nomeMecanica
       MERGE (m:Mecanica {nome: nomeMecanica})
       MERGE (g)-[:USA_MECANICA]->(m)`,
      { jogos }
    );

    await tx.run(
      `UNWIND $jogos AS j
       MATCH (g:Jogo {id: j.id})
       UNWIND j.designers AS nomeDesigner
       MERGE (d:Designer {nome: nomeDesigner})
       MERGE (g)-[:CRIADO_POR]->(d)`,
      { jogos }
    );

    return contarGrafo(tx);
  });
}

let filaDeSincronizacao = Promise.resolve();

function sincronizarGrafo() {
  const execucao = filaDeSincronizacao.then(executarSincronizacao);
  filaDeSincronizacao = execucao.catch(() => {});
  return execucao;
}

app.post('/sync', async (req, res) => {
  try {
    const contagem = await sincronizarGrafo();
    console.log(
      `[afinidades] grafo reconstruído: ${contagem.jogos} jogos, ${contagem.mecanicas} mecânicas, ` +
        `${contagem.designers} designers, ${contagem.relacoes} relações`
    );
    res.json({ ok: true, ...contagem });
  } catch (erro) {
    if (erro instanceof ErroAcervo) {
      console.warn('[afinidades] sync abortado:', erro.message);
      return res.status(502).json({ erro: erro.message });
    }
    responderErro(res, erro, 'reconstruir o grafo');
  }
});

app.put('/grafo/jogos/:id', async (req, res) => {
  const corpo = req.body && typeof req.body === 'object' ? req.body : {};
  const id = req.params.id.trim();
  const nome = typeof corpo.nome === 'string' ? corpo.nome.trim() : '';

  if (!id) return res.status(400).json({ erro: 'Informe o id do jogo' });
  if (!nome) return res.status(400).json({ erro: 'O campo "nome" é obrigatório' });

  const categoria =
    typeof corpo.categoria === 'string' && corpo.categoria.trim() ? corpo.categoria.trim() : 'Outros';
  const mecanicas = normalizarLista(corpo.mecanicas, normalizarMecanica);
  const designers = normalizarLista(corpo.designers, normalizarDesigner);

  try {
    await escreverGrafo(async (tx) => {
      await tx.run('MERGE (g:Jogo {id: $id}) SET g.nome = $nome, g.categoria = $categoria', {
        id,
        nome,
        categoria
      });

      await tx.run('MATCH (:Jogo {id: $id})-[r:USA_MECANICA|CRIADO_POR]->() DELETE r', { id });

      await tx.run(
        `MATCH (g:Jogo {id: $id})
         FOREACH (nomeMecanica IN $mecanicas |
           MERGE (m:Mecanica {nome: nomeMecanica})
           MERGE (g)-[:USA_MECANICA]->(m))
         FOREACH (nomeDesigner IN $designers |
           MERGE (d:Designer {nome: nomeDesigner})
           MERGE (g)-[:CRIADO_POR]->(d))`,
        { id, mecanicas, designers }
      );

      await limparOrfaos(tx);
    });
    res.json({ ok: true });
  } catch (erro) {
    responderErro(res, erro, 'atualizar o jogo no grafo');
  }
});

app.delete('/grafo/jogos/:id', async (req, res) => {
  const id = req.params.id.trim();
  try {
    const removido = await escreverGrafo(async (tx) => {
      const resultado = await tx.run(
        `MATCH (g:Jogo {id: $id})
         DETACH DELETE g
         RETURN count(*) AS removidos`,
        { id }
      );
      await limparOrfaos(tx);
      return resultado.records[0].get('removidos') > 0;
    });
    res.json({ ok: true, removido });
  } catch (erro) {
    responderErro(res, erro, 'remover o jogo do grafo');
  }
});

app.get('/similares/:jogoId', async (req, res) => {
  const { jogoId } = req.params;
  try {
    const similares = await lerGrafo(async (tx) => {
      const resultado = await tx.run(
        `MATCH (origem:Jogo {id: $jogoId})-[:USA_MECANICA|CRIADO_POR]->(x)<-[:USA_MECANICA|CRIADO_POR]-(outro:Jogo)
         WHERE outro <> origem
         WITH outro, collect(DISTINCT x) AS comuns
         WITH outro,
              [n IN comuns WHERE n:Mecanica | n.nome] AS mecanicas,
              [n IN comuns WHERE n:Designer | n.nome] AS designers
         RETURN outro.id AS jogoId, outro.nome AS nome, outro.categoria AS categoria,
                mecanicas AS mecanicasEmComum, designers AS designersEmComum,
                size(mecanicas) + 2 * size(designers) AS pontuacao
         ORDER BY pontuacao DESC, nome ASC
         LIMIT 5`,
        { jogoId }
      );
      return resultado.records.map((registro) => ({
        jogoId: registro.get('jogoId'),
        nome: registro.get('nome'),
        categoria: registro.get('categoria'),
        mecanicasEmComum: ordenarTextos(registro.get('mecanicasEmComum')),
        designersEmComum: ordenarTextos(registro.get('designersEmComum')),
        pontuacao: registro.get('pontuacao')
      }));
    });
    res.json(similares);
  } catch (erro) {
    responderErro(res, erro, 'buscar jogos parecidos');
  }
});

app.get('/jogos/:jogoId/mecanicas', async (req, res) => {
  const { jogoId } = req.params;
  try {
    const dados = await lerGrafo(async (tx) => {
      const resultado = await tx.run(
        `MATCH (g:Jogo {id: $jogoId})
         OPTIONAL MATCH (g)-[:USA_MECANICA]->(m:Mecanica)
         WITH g, m
         ORDER BY m.nome
         RETURN g.nome AS jogo, collect(m.nome) AS mecanicas`,
        { jogoId }
      );
      if (resultado.records.length === 0) return null;
      const registro = resultado.records[0];
      return { jogo: registro.get('jogo'), mecanicas: registro.get('mecanicas') };
    });

    if (!dados) return res.status(404).json({ erro: 'Jogo não encontrado no grafo' });
    res.json(dados);
  } catch (erro) {
    responderErro(res, erro, 'listar as mecânicas do jogo');
  }
});

app.post('/mecanicas/:jogoId/:mecanica', async (req, res) => {
  const { jogoId } = req.params;
  const mecanica = normalizarMecanica(req.params.mecanica);
  if (!mecanica) return res.status(400).json({ erro: 'Informe o nome da mecânica' });

  try {
    const ligacao = await escreverGrafo(async (tx) => {
      const resultado = await tx.run(
        `MATCH (g:Jogo {id: $jogoId})
         MERGE (m:Mecanica {nome: $mecanica})
         MERGE (g)-[:USA_MECANICA]->(m)
         RETURN g.nome AS jogo, m.nome AS mecanica`,
        { jogoId, mecanica }
      );
      if (resultado.records.length === 0) return null;
      const registro = resultado.records[0];
      return { jogo: registro.get('jogo'), mecanica: registro.get('mecanica') };
    });

    if (!ligacao) return res.status(404).json({ erro: 'Jogo não encontrado no grafo' });
    res.status(201).json({ ok: true, ...ligacao });
  } catch (erro) {
    responderErro(res, erro, 'ligar a mecânica ao jogo');
  }
});

app.put('/mecanicas/:antiga/:nova', async (req, res) => {
  const antiga = normalizarMecanica(req.params.antiga);
  const nova = normalizarMecanica(req.params.nova);
  if (!antiga || !nova) {
    return res.status(400).json({ erro: 'Informe o nome atual e o nome novo da mecânica' });
  }

  try {
    const resultado = await escreverGrafo(async (tx) => {
      const origem = await tx.run('MATCH (m:Mecanica {nome: $antiga}) RETURN m.nome AS nome', { antiga });
      if (origem.records.length === 0) return { situacao: 'origem-inexistente' };

      if (nova !== antiga) {
        const destino = await tx.run('MATCH (m:Mecanica {nome: $nova}) RETURN m.nome AS nome', { nova });
        if (destino.records.length > 0) return { situacao: 'destino-ocupado' };
      }

      const renomeio = await tx.run(
        `MATCH (m:Mecanica {nome: $antiga})
         SET m.nome = $nova
         WITH m
         OPTIONAL MATCH (m)<-[:USA_MECANICA]-(g:Jogo)
         RETURN m.nome AS mecanica, count(DISTINCT g) AS jogosAfetados`,
        { antiga, nova }
      );
      if (renomeio.records.length === 0) return { situacao: 'origem-inexistente' };
      const registro = renomeio.records[0];
      return {
        situacao: 'ok',
        mecanica: registro.get('mecanica'),
        jogosAfetados: registro.get('jogosAfetados')
      };
    });

    if (resultado.situacao === 'origem-inexistente') {
      return res.status(404).json({ erro: `Mecânica "${antiga}" não encontrada no grafo` });
    }
    if (resultado.situacao === 'destino-ocupado') {
      return res.status(409).json({ erro: `Já existe uma mecânica chamada "${nova}"` });
    }
    res.json({ ok: true, mecanica: resultado.mecanica, jogosAfetados: resultado.jogosAfetados });
  } catch (erro) {
    if (erro && erro.code === 'Neo.ClientError.Schema.ConstraintValidationFailed') {
      return res.status(409).json({ erro: `Já existe uma mecânica chamada "${nova}"` });
    }
    responderErro(res, erro, 'renomear a mecânica');
  }
});

app.delete('/mecanicas/:jogoId/:mecanica', async (req, res) => {
  const { jogoId } = req.params;
  const mecanica = normalizarMecanica(req.params.mecanica);
  if (!mecanica) return res.status(400).json({ erro: 'Informe o nome da mecânica' });

  try {
    const resultado = await escreverGrafo(async (tx) => {
      const remocao = await tx.run(
        `MATCH (:Jogo {id: $jogoId})-[r:USA_MECANICA]->(:Mecanica {nome: $mecanica})
         DELETE r
         RETURN count(*) AS removidas`,
        { jogoId, mecanica }
      );
      if (remocao.records[0].get('removidas') === 0) return null;

      const faxina = await tx.run(
        `MATCH (m:Mecanica {nome: $mecanica})
         WITH m, COUNT { (m)--() } AS restantes
         WHERE restantes = 0
         DELETE m
         RETURN count(*) AS apagadas`,
        { mecanica }
      );
      return { mecanicaRemovidaDoGrafo: faxina.records[0].get('apagadas') > 0 };
    });

    if (!resultado) {
      return res.status(404).json({ erro: 'Esse jogo não está ligado a essa mecânica no grafo' });
    }
    res.json({ ok: true, relacaoRemovida: true, mecanicaRemovidaDoGrafo: resultado.mecanicaRemovidaDoGrafo });
  } catch (erro) {
    responderErro(res, erro, 'desligar a mecânica do jogo');
  }
});

app.get('/mecanicas/populares', async (req, res) => {
  const limite = inteiroEntre(req.query.limite, 10, 1, 50);
  try {
    const populares = await lerGrafo(async (tx) => {
      const resultado = await tx.run(
        `MATCH (m:Mecanica)
         WITH m, COUNT { (m)<-[:USA_MECANICA]-() } AS totalJogos
         WHERE totalJogos > 0
         RETURN m.nome AS mecanica, totalJogos
         ORDER BY totalJogos DESC, mecanica ASC
         LIMIT $limite`,
        { limite: neo4j.int(limite) }
      );
      return resultado.records.map((registro) => ({
        mecanica: registro.get('mecanica'),
        totalJogos: registro.get('totalJogos')
      }));
    });
    res.json(populares);
  } catch (erro) {
    responderErro(res, erro, 'listar as mecânicas populares');
  }
});

app.get('/grafo/resumo', async (req, res) => {
  try {
    res.json(await lerGrafo(contarGrafo));
  } catch (erro) {
    responderErro(res, erro, 'resumir o grafo');
  }
});

app.get('/saude', async (req, res) => {
  try {
    await driver.verifyConnectivity();
    res.json({ ok: true, banco: 'neo4j' });
  } catch (erro) {
    res.status(503).json({ ok: false, banco: 'neo4j', erro: `Neo4j inacessível: ${erro.message}` });
  }
});

app.use((req, res) => {
  res.status(404).json({ erro: `Rota não encontrada: ${req.method} ${req.path}` });
});

app.use((erro, req, res, next) => {
  if (erro && erro.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido' });
  }
  if (erro && erro.status >= 400 && erro.status < 500) {
    return res.status(erro.status).json({ erro: 'Requisição inválida' });
  }
  console.error('[afinidades] erro não tratado:', erro);
  res.status(500).json({ erro: 'Erro interno no serviço de afinidades' });
});

async function esperarNeo4jSubir() {
  for (let tentativa = 1; tentativa <= TENTATIVAS_CONEXAO; tentativa++) {
    try {
      await driver.verifyConnectivity();
      console.log(`[afinidades] conectado ao Neo4j em ${NEO4J_URL}`);
      return;
    } catch (erro) {
      console.log(`[afinidades] Neo4j ainda não respondeu (${tentativa}/${TENTATIVAS_CONEXAO}): ${erro.message}`);
      await esperar(ESPERA_ENTRE_TENTATIVAS_MS);
    }
  }
  throw new Error(`Neo4j não respondeu depois de ${TENTATIVAS_CONEXAO} tentativas`);
}

const RESTRICOES = [
  'CREATE CONSTRAINT jogo_id_unico IF NOT EXISTS FOR (j:Jogo) REQUIRE j.id IS UNIQUE',
  'CREATE CONSTRAINT mecanica_nome_unico IF NOT EXISTS FOR (m:Mecanica) REQUIRE m.nome IS UNIQUE',
  'CREATE CONSTRAINT designer_nome_unico IF NOT EXISTS FOR (d:Designer) REQUIRE d.nome IS UNIQUE'
];

async function criarRestricoes() {
  const sessao = driver.session();
  try {
    for (const comando of RESTRICOES) {
      await sessao.run(comando);
    }
    console.log('[afinidades] constraints de unicidade conferidas');
  } finally {
    await sessao.close();
  }
}

async function sincronizarSeGrafoVazio() {
  const { jogos } = await lerGrafo(contarGrafo);
  if (jogos > 0) {
    console.log(`[afinidades] grafo já tem ${jogos} jogos, sem sincronização automática`);
    return;
  }
  console.log('[afinidades] grafo vazio, tentando puxar o acervo uma vez...');
  const contagem = await sincronizarGrafo();
  console.log(`[afinidades] sincronização inicial: ${contagem.jogos} jogos no grafo`);
}

let servidor = null;

async function iniciar() {
  await esperarNeo4jSubir();
  await criarRestricoes();

  servidor = app.listen(PORTA, () => {
    console.log(`[afinidades] ouvindo na porta ${PORTA}`);
    sincronizarSeGrafoVazio().catch((erro) => {
      console.warn('[afinidades] sincronização inicial não rolou:', erro.message);
    });
  });
}

async function encerrar(sinal) {
  console.log(`[afinidades] recebi ${sinal}, encerrando...`);
  if (servidor) servidor.close();
  try {
    await driver.close();
  } catch (erro) {
    console.warn('[afinidades] erro ao fechar o driver:', erro.message);
  }
  process.exit(0);
}

process.once('SIGTERM', () => encerrar('SIGTERM'));
process.once('SIGINT', () => encerrar('SIGINT'));

iniciar().catch(async (erro) => {
  console.error('[afinidades] não deu pra subir o serviço:', erro.message);
  await driver.close().catch(() => {});
  process.exit(1);
});
