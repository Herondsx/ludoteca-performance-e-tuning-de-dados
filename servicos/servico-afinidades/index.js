/*
 * servico-afinidades (Ludoteca) — Neo4j 5, porta 4003
 * ---------------------------------------------------------------------------
 * A pergunta que esse serviço responde é: "curti esse jogo, o que mais eu
 * deveria experimentar?". A gente responde olhando o que os jogos têm em
 * comum: mecânicas parecidas e, principalmente, o mesmo designer.
 *
 * Modelo do grafo:
 *   (:Jogo {id, nome, categoria})-[:USA_MECANICA]->(:Mecanica {nome})
 *   (:Jogo)-[:CRIADO_POR]->(:Designer {nome})
 *
 * Por que grafo e não os outros dois bancos?
 *   - No Postgres isso viraria tabela de ligação jogo_mecanica + jogo_designer
 *     e um self-join contando interseções. Funciona, mas a consulta fica
 *     enorme e o custo cresce junto com as tabelas inteiras.
 *   - No Mongo teríamos que trazer os documentos e cruzar os arrays no código.
 *   - No Neo4j cada relação é guardada "grudada" no nó (adjacência sem índice),
 *     então o passeio jogo -> mecânica -> outro jogo só visita a vizinhança do
 *     jogo de origem. O custo depende do tamanho dessa vizinhança, não do banco.
 *
 * Quem é dono dos dados é o servico-acervo (MongoDB). O grafo aqui é uma
 * PROJEÇÃO: o acervo avisa a cada criação/edição/remoção de jogo, e se algo
 * sair de sincronia dá pra reconstruir tudo com POST /sync.
 *
 * Pra mostrar o grafo desenhado na apresentação: abrir http://localhost:7474,
 * entrar com neo4j / ludoteca123 e rodar  MATCH (j:Jogo)-[r]->(x) RETURN j, r, x
 */

const express = require('express');
const cors = require('cors');
const neo4j = require('neo4j-driver');

// ---------------------------------------------------------------------------
// Configuração (tudo vem do docker-compose; os padrões servem pra rodar fora dele)
// ---------------------------------------------------------------------------
const PORTA = Number(process.env.PORT) || 4003;
const NEO4J_URL = process.env.NEO4J_URL || 'bolt://localhost:7687';
const NEO4J_USUARIO = process.env.NEO4J_USUARIO || 'neo4j';
const NEO4J_SENHA = process.env.NEO4J_SENHA || 'ludoteca123';
// tira a barra final, se alguém configurar "http://host:4002/", pra não virar "//jogos"
const ACERVO_URL = (process.env.ACERVO_URL || 'http://localhost:4002').replace(/\/+$/, '');

const TENTATIVAS_CONEXAO = 30;
const ESPERA_ENTRE_TENTATIVAS_MS = 2000;
const TEMPO_MAXIMO_ACERVO_MS = 10000;

// O Neo4j trabalha com inteiros de 64 bits e, por padrão, o driver devolve um
// objeto Integer pra não perder precisão. Nossas contagens são pequenas, então
// o disableLosslessIntegers faz elas chegarem como number comum do JS (nada de
// .toNumber() espalhado pelo código).
// Pegadinha do outro lado: quando a gente ENVIA um number do JS, o driver manda
// como float. Em "LIMIT $limite" isso quebra (LIMIT 10.0 não vale), por isso
// nesses casos o parâmetro vai embrulhado em neo4j.int().
const driver = neo4j.driver(NEO4J_URL, neo4j.auth.basic(NEO4J_USUARIO, NEO4J_SENHA), {
  disableLosslessIntegers: true
});

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

// Mecânica vai pra minúsculas: "Draft", "draft" e " DRAFT " precisam virar um
// nó só. Se cada grafia gerasse um nó próprio, dois jogos com a mesma
// mecânica não se encontrariam no grafo e a afinidade entre eles sumiria.
function normalizarMecanica(valor) {
  return typeof valor === 'string' ? valor.trim().toLowerCase() : '';
}

// Designer é nome próprio, então só tiramos os espaços e mantemos a caixa.
function normalizarDesigner(valor) {
  return typeof valor === 'string' ? valor.trim() : '';
}

// Normaliza cada item, descarta vazios e remove repetidos (o Set cuida disso).
function normalizarLista(lista, normalizar) {
  if (!Array.isArray(lista)) return [];
  return [...new Set(lista.map(normalizar).filter(Boolean))];
}

function ordenarTextos(lista) {
  return [...(lista || [])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

// Lê um inteiro da query string e prende dentro de [minimo, maximo].
function inteiroEntre(valor, padrao, minimo, maximo) {
  const numero = Number.parseInt(valor, 10);
  if (Number.isNaN(numero)) return padrao;
  return Math.min(maximo, Math.max(minimo, numero));
}

function esperar(ms) {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

// Erro específico pra quando o problema é no acervo (rede, status, JSON).
// Serve pra rota /sync responder 502 (falha no serviço vizinho) em vez de 500.
class ErroAcervo extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroAcervo';
  }
}

// Transações gerenciadas (executeRead/executeWrite): o driver faz commit
// sozinho, dá rollback se a função lançar erro e ainda REPETE a função se o
// erro for transitório (deadlock, troca de líder, conexão caída). Por isso o
// "trabalho" passado aqui só pode mexer no banco — nada de responder HTTP ou
// chamar outro serviço lá dentro, porque ele pode rodar mais de uma vez.
// A sessão é fechada no finally pra devolver a conexão ao pool sempre.
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

// Converte erro em resposta HTTP sem vazar detalhe interno pro cliente.
// Banco fora do ar / erro transitório -> 503 (tente de novo); resto -> 500.
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

// ---------------------------------------------------------------------------
// Operações reaproveitadas
// ---------------------------------------------------------------------------

// Fotografia do tamanho do grafo numa consulta só (1 ida ao banco em vez de 4).
// Cada COUNT { } é uma subconsulta independente; contar nós por rótulo é
// barato porque o Neo4j mantém um contador por rótulo/tipo de relação.
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

// Apaga Mecanica/Designer que ficaram sem nenhum jogo ligado.
// Sem isso, depois de algumas edições o grafo acumula nós soltos que só
// poluem a visualização e as contagens do monitor.
// O ":Mecanica|Designer" (expressão de rótulo do Neo4j 5) deixa o planner
// varrer só esses dois rótulos, em vez de passar por todos os nós do banco.
async function limparOrfaos(tx) {
  const resultado = await tx.run(`
    MATCH (n:Mecanica|Designer)
    WHERE NOT (n)--()
    DELETE n
    RETURN count(*) AS removidos
  `);
  return resultado.records[0].get('removidos');
}

// Busca o catálogo no acervo e já devolve no formato que o grafo precisa.
async function buscarJogosDoAcervo() {
  let resposta;
  try {
    // limite=100 é o máximo que o acervo aceita; garante que a reconstrução
    // não fique só com a primeira "página" do catálogo.
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

  // Map por id: se por algum motivo vier jogo repetido, fica só uma entrada.
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

// Reconstrói o grafo inteiro a partir do acervo.
async function executarSincronizacao() {
  // O HTTP pro acervo acontece FORA da transação: não faz sentido segurar
  // locks no Neo4j esperando rede, e a função da transação pode ser repetida.
  const jogos = await buscarJogosDoAcervo();

  return escreverGrafo(async (tx) => {
    // Apaga só os rótulos deste serviço (nada de "MATCH (n) DETACH DELETE n"
    // no banco todo). Tudo dentro da mesma transação: se a recriação falhar,
    // o rollback devolve o grafo antigo e ninguém vê o grafo pela metade.
    await tx.run('MATCH (n:Jogo|Mecanica|Designer) DETACH DELETE n');

    // TUNING: UNWIND manda a lista inteira de uma vez e o Neo4j itera do lado
    // dele. É 1 ida ao banco em vez de uma query por jogo e outra por mecânica
    // (com 15 jogos e ~50 ligações, isso economiza dezenas de round-trips).
    // O MERGE do Jogo vem ANTES do segundo UNWIND de propósito: UNWIND de
    // lista vazia não gera linha nenhuma, então se o MERGE ficasse depois,
    // jogo sem mecânica simplesmente sumiria do grafo.
    // Os MERGE por id/nome são rápidos porque as constraints de unicidade
    // criam índice; sem elas cada MERGE varreria todos os nós do rótulo.
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

    // Mesmo esquema pros designers. Aqui o Jogo já existe (criado acima),
    // então basta um MATCH pelo id, que usa o índice da constraint.
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

// Fila simples: se chegarem dois /sync ao mesmo tempo (botão do monitor
// clicado várias vezes, seed rodando junto do sync automático...), o segundo
// espera o primeiro terminar e depois roda com dados frescos. Assim duas
// transações não ficam brigando pelos mesmos nós.
let filaDeSincronizacao = Promise.resolve();

function sincronizarGrafo() {
  const execucao = filaDeSincronizacao.then(executarSincronizacao);
  // a fila em si nunca fica "quebrada": o erro é tratado por quem chamou
  filaDeSincronizacao = execucao.catch(() => {});
  return execucao;
}

// ---------------------------------------------------------------------------
// Rotas — sincronização com o acervo
// ---------------------------------------------------------------------------

// Reconstrução completa (chamada pelo seed do acervo e pelo monitor).
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

// Upsert de UM jogo (o acervo chama depois de cada POST/PUT).
// Mais barato que reconstruir tudo: mexe só na vizinhança desse jogo.
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
      // 1) cria o jogo se ele ainda não estiver no grafo e atualiza os dados
      await tx.run('MERGE (g:Jogo {id: $id}) SET g.nome = $nome, g.categoria = $categoria', {
        id,
        nome,
        categoria
      });

      // 2) solta só as ligações QUE SAEM deste jogo; os outros jogos não
      //    são tocados
      await tx.run('MATCH (:Jogo {id: $id})-[r:USA_MECANICA|CRIADO_POR]->() DELETE r', { id });

      // 3) religa conforme a versão nova. FOREACH aceita lista vazia sem
      //    descartar a linha (diferente do UNWIND), então dá pra fazer
      //    mecânicas e designers no mesmo comando.
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

      // 4) se alguma mecânica/designer deixou de ser usada, some do grafo
      await limparOrfaos(tx);
    });
    res.json({ ok: true });
  } catch (erro) {
    responderErro(res, erro, 'atualizar o jogo no grafo');
  }
});

// Remoção de UM jogo (o acervo chama depois de cada DELETE).
app.delete('/grafo/jogos/:id', async (req, res) => {
  const id = req.params.id.trim();
  try {
    const removido = await escreverGrafo(async (tx) => {
      // DETACH DELETE apaga o nó junto com as relações dele.
      // count(*) depois do DELETE sempre devolve uma linha (0 se não achou).
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

// ---------------------------------------------------------------------------
// Rotas — consultas de afinidade
// ---------------------------------------------------------------------------

// Até 5 jogos parecidos. O caminho é:
//   jogo de origem -> (mecânica ou designer) <- outro jogo
// Cada nó intermediário é algo em comum. Pontuação = mecânicas em comum +
// 2 x designers em comum (mesmo designer pesa mais: costuma indicar o mesmo
// "estilo" de jogo).
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
    // jogo sem vizinhos (ou fora do grafo) devolve lista vazia mesmo
    res.json(similares);
  } catch (erro) {
    responderErro(res, erro, 'buscar jogos parecidos');
  }
});

// ---------------------------------------------------------------------------
// Rotas — mecânicas: ligar, consultar, renomear e desligar
// (mostram na apresentação como cada operação fica pequena no modelo de grafo)
// ---------------------------------------------------------------------------

// READ: mecânicas de um jogo, em ordem alfabética.
app.get('/jogos/:jogoId/mecanicas', async (req, res) => {
  const { jogoId } = req.params;
  try {
    const dados = await lerGrafo(async (tx) => {
      // OPTIONAL MATCH: jogo sem mecânica ainda aparece (com lista vazia);
      // collect() ignora o null que sobra nesse caso.
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

// CREATE: liga uma mecânica a um jogo. MERGE funciona como "acha ou cria":
// reaproveita o nó da mecânica quando ele já está no grafo, e chamar a rota
// duas vezes não gera ligação repetida.
app.post('/mecanicas/:jogoId/:mecanica', async (req, res) => {
  const { jogoId } = req.params;
  const mecanica = normalizarMecanica(req.params.mecanica);
  if (!mecanica) return res.status(400).json({ erro: 'Informe o nome da mecânica' });

  try {
    const ligacao = await escreverGrafo(async (tx) => {
      // se o MATCH do jogo não achar nada, nenhuma linha segue adiante e os
      // MERGE nem rodam — por isso a lista de registros vazia vira 404
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

// UPDATE: troca o nome da mecânica. Os jogos não guardam o nome, eles
// apontam pro nó; então um único SET numa propriedade reflete em todos os
// jogos que usam essa mecânica, sem reescrever nada do lado deles.
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

      // Se o nome novo já existe, renomear criaria duas mecânicas "iguais"
      // (e a constraint de unicidade barraria de qualquer jeito). Melhor
      // avisar com 409 do que estourar erro do banco.
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
    // Corrida rara: outra requisição criou o nome novo entre a checagem e o
    // SET. A constraint segura a duplicata e a gente traduz pra 409.
    if (erro && erro.code === 'Neo.ClientError.Schema.ConstraintValidationFailed') {
      return res.status(409).json({ erro: `Já existe uma mecânica chamada "${nova}"` });
    }
    responderErro(res, erro, 'renomear a mecânica');
  }
});

// DELETE: desliga a mecânica de UM jogo. Se ninguém mais usar a mecânica,
// o nó também sai. São 2 passos, mas dentro da MESMA transação: ou acontecem
// os dois, ou nenhum.
app.delete('/mecanicas/:jogoId/:mecanica', async (req, res) => {
  const { jogoId } = req.params;
  const mecanica = normalizarMecanica(req.params.mecanica);
  if (!mecanica) return res.status(400).json({ erro: 'Informe o nome da mecânica' });

  try {
    const resultado = await escreverGrafo(async (tx) => {
      // passo 1: remove só a relação entre este jogo e esta mecânica
      const remocao = await tx.run(
        `MATCH (:Jogo {id: $jogoId})-[r:USA_MECANICA]->(:Mecanica {nome: $mecanica})
         DELETE r
         RETURN count(*) AS removidas`,
        { jogoId, mecanica }
      );
      if (remocao.records[0].get('removidas') === 0) return null;

      // passo 2: conta quantas relações a mecânica ainda tem; se zerou,
      // apaga o nó (o WHERE filtra e o DELETE só roda nesse caso)
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

// Ranking das mecânicas que aparecem em mais jogos (alimenta o cartão do
// Neo4j no monitor).
app.get('/mecanicas/populares', async (req, res) => {
  const limite = inteiroEntre(req.query.limite, 10, 1, 50);
  try {
    const populares = await lerGrafo(async (tx) => {
      // TUNING: COUNT { (m)<-[:USA_MECANICA]-() } sem filtro no outro lado
      // pode ser respondido pelo grau do nó (o Neo4j guarda quantas relações
      // de cada tipo um nó tem), sem precisar caminhar relação por relação.
      // Só Jogo usa USA_MECANICA, então não precisamos checar o rótulo.
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

// ---------------------------------------------------------------------------
// Rotas — monitoramento
// ---------------------------------------------------------------------------

// Contagens pro cartão do Neo4j no monitor.
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

// ---------------------------------------------------------------------------
// 404 e tratamento final de erros (sempre em JSON)
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ erro: `Rota não encontrada: ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((erro, req, res, next) => {
  // corpo com JSON quebrado cai aqui, vindo do express.json()
  if (erro && erro.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido' });
  }
  if (erro && erro.status >= 400 && erro.status < 500) {
    return res.status(erro.status).json({ erro: 'Requisição inválida' });
  }
  console.error('[afinidades] erro não tratado:', erro);
  res.status(500).json({ erro: 'Erro interno no serviço de afinidades' });
});

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

// O healthcheck do compose só confere a porta HTTP (7474). A porta Bolt
// (7687), que é a que o driver usa, pode levar mais alguns segundos pra abrir,
// por isso este laço de tentativas antes de criar as constraints.
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

// As constraints de unicidade fazem dois papéis: impedem nó duplicado
// (mesmo jogo/mecânica/designer duas vezes) e criam o índice que deixa
// MERGE e MATCH por id/nome instantâneos.
// Cada uma vai num session.run próprio (transação automática): o Neo4j não
// deixa misturar mudança de schema com escrita de dados na mesma transação.
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

// Se o volume do Neo4j for novo (grafo vazio) mas o acervo já tiver jogos,
// puxamos tudo uma vez sozinhos. Se o acervo ainda não estiver pronto, só
// registra no log — o seed (ou o botão do monitor) chama o /sync depois.
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
    // não bloqueia: o serviço já atende enquanto isso roda em segundo plano
    sincronizarSeGrafoVazio().catch((erro) => {
      console.warn('[afinidades] sincronização inicial não rolou:', erro.message);
    });
  });
}

// Desligamento educado: o "docker compose down" manda SIGTERM. Fechando o
// driver, as conexões Bolt são encerradas direitinho do lado do Neo4j.
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
  try {
    await driver.close();
  } catch {
    // já estamos saindo; erro aqui não muda nada
  }
  // sai com erro pro "restart: on-failure" do compose tentar de novo
  process.exit(1);
});
