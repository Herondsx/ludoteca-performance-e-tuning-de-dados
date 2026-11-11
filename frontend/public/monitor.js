// monitor.js — "Monitor dos Bancos" da Ludoteca
//
// A ideia aqui é mostrar a persistência poliglota funcionando de verdade:
// de 3 em 3 segundos o navegador pergunta pras três APIs o que tem em cada
// banco (PostgreSQL, MongoDB e Neo4j) e redesenha os cartões. Os botões de
// demonstração gravam dados novos pra gente ver os números mudando ao vivo.
//
// Duas decisões que valem explicar na apresentação:
//  1) cada cartão é consultado de forma independente (Promise.allSettled),
//     então se um banco cair o cartão dele fica "offline" e os outros seguem;
//  2) uma rodada nunca começa antes da anterior terminar — se a rede estiver
//     lenta, a gente pula o tique em vez de empilhar requisições no servidor.

'use strict';

// ---------------------------------------------------------------------------
// CONFIGURAÇÃO
// ---------------------------------------------------------------------------

// as URLs vêm do config.js (compartilhado com o app). O objeto de reserva só
// existe pra página não morrer se alguém esquecer de carregar o config.js.
const API = window.LUDOTECA_API || {
  jogadores: 'http://localhost:4001',
  acervo: 'http://localhost:4002',
  afinidades: 'http://localhost:4003'
};

const INTERVALO_ATUALIZACAO_MS = 3 * 1000; // 3 segundos entre uma rodada e outra
// tempo máximo de uma consulta normal. Sem isso, um serviço travado deixaria
// a rodada pendurada pra sempre e (como a gente não sobrepõe rodadas) o monitor congelaria.
const TEMPO_LIMITE_MS = 4000;
// o /sync apaga e recria o grafo inteiro, então merece mais paciência
const TEMPO_LIMITE_SYNC_MS = 20000;
const MAXIMO_LINHAS_REGISTRO = 15;

const CATEGORIAS = ['Estratégia', 'Família', 'Cooperativo', 'Party', 'Cartas', 'Abstrato', 'Outros'];

// mecânicas que já existem no seed: sorteando daqui, o jogo de teste já nasce
// ligado a jogos reais no grafo e aparece como "parecido" com eles
const MECANICAS_DO_SEED = [
  'Rolagem de dados', 'Negociação', 'Construção de rotas', 'Gestão de recursos',
  'Tabuleiro modular', 'Coleção de conjuntos', 'Draft', 'Objetivos secretos',
  'Colocação de peças', 'Controle de área', 'Cooperativo', 'Gestão de mão',
  'Poderes variáveis', 'Pontos de ação', 'Construção de padrões', 'Ações simultâneas',
  'Construção de motor', 'Comunicação limitada', 'Dedução', 'Construção de baralho',
  'Alocação de trabalhadores', 'Trilha de tempo', 'Jogo em equipes', 'Narração', 'Votação'
];

// estado de cada cartão: nome bonito, se estava online e a "assinatura"
// (os números da última leitura) pra saber quando piscar o cartão
const CARTOES = {
  postgres: { nome: 'PostgreSQL', idCartao: 'cartao-postgres', idLuz: 'luz-postgres', idTempo: 'pg-tempo', online: null, assinatura: null },
  mongo: { nome: 'MongoDB', idCartao: 'cartao-mongo', idLuz: 'luz-mongo', idTempo: 'mg-tempo', online: null, assinatura: null },
  neo4j: { nome: 'Neo4j', idCartao: 'cartao-neo4j', idLuz: 'luz-neo4j', idTempo: 'neo-tempo', online: null, assinatura: null }
};

let rodadaEmAndamento = false;
let rodadaExtraPedida = false;

// ---------------------------------------------------------------------------
// UTILITÁRIOS
// ---------------------------------------------------------------------------

// tudo que vem das APIs passa por aqui antes de entrar num innerHTML.
// Um jogo chamado "<img onerror=...>" vira texto, não código (anti-XSS).
function escaparHtml(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// o grafo guarda mecânicas em minúsculas (pra "Draft" e "draft" virarem um nó só),
// então na hora de exibir a gente devolve a primeira letra maiúscula
function capitalizar(texto) {
  const limpo = String(texto || '').trim();
  return limpo ? limpo.charAt(0).toLocaleUpperCase('pt-BR') + limpo.slice(1) : '';
}

function formatarNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero.toLocaleString('pt-BR') : '—';
}

function horaAgora() {
  return new Date().toLocaleTimeString('pt-BR', { hour12: false });
}

function tempoRelativo(dataIso) {
  const data = new Date(dataIso);
  if (Number.isNaN(data.getTime())) return '';
  const segundos = Math.max(0, Math.round((Date.now() - data.getTime()) / 1000));
  if (segundos < 45) return 'agora há pouco';
  const minutos = Math.round(segundos / 60);
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 24) return `há ${horas} h`;
  const dias = Math.round(horas / 24);
  return dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
}

function numeroAleatorio(minimo, maximo) {
  return Math.floor(Math.random() * (maximo - minimo + 1)) + minimo;
}

function sortearUm(lista) {
  return lista[Math.floor(Math.random() * lista.length)];
}

// Fisher-Yates numa cópia, pra não bagunçar a lista original
function embaralhar(lista) {
  const copia = lista.slice();
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

// pedaço final do ObjectId, pra mostrar algo quando o nome do jogo não veio
function idCurto(id) {
  const texto = String(id || '');
  return texto.length > 6 ? '…' + texto.slice(-6) : texto;
}

// proporção 0..100 pras barrinhas (sempre um número, nunca texto vindo da API)
function percentual(valor, maximo) {
  const v = Number(valor);
  const m = Number(maximo);
  if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return 0;
  return Math.max(4, Math.min(100, Math.round((v / m) * 100)));
}

// reinicia uma animação CSS mesmo se a classe já estiver aplicada
// (remove, força o navegador a recalcular o layout e coloca de volta)
const temporizadoresAnimacao = new WeakMap();
function reiniciarAnimacao(elemento, classe, duracaoMs) {
  if (!elemento) return;
  clearTimeout(temporizadoresAnimacao.get(elemento));
  elemento.classList.remove(classe);
  void elemento.offsetWidth;
  elemento.classList.add(classe);
  temporizadoresAnimacao.set(elemento, setTimeout(() => elemento.classList.remove(classe), duracaoMs));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// fetch com tempo limite + leitura padronizada do { erro } das APIs.
// Detalhe de tuning: os GETs vão sem Content-Type nem cabeçalho customizado, então
// o navegador não precisa mandar o "preflight" OPTIONS do CORS antes de cada um —
// metade das idas e vindas a cada 3 s.
async function buscarJson(url, { metodo = 'GET', corpo, tempoLimite = TEMPO_LIMITE_MS } = {}) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), tempoLimite);
  const opcoes = { method: metodo, cache: 'no-store', signal: controlador.signal, headers: {} };
  if (corpo !== undefined) {
    opcoes.headers['Content-Type'] = 'application/json';
    opcoes.body = JSON.stringify(corpo);
  }

  try {
    const resposta = await fetch(url, opcoes);
    const texto = await resposta.text();
    let dados = null;
    if (texto) {
      try {
        dados = JSON.parse(texto);
      } catch (_) {
        dados = null; // resposta que não é JSON (ex.: página de erro do proxy)
      }
    }
    if (!resposta.ok) {
      const erro = new Error((dados && dados.erro) || `HTTP ${resposta.status}`);
      erro.status = resposta.status;
      throw erro;
    }
    return dados;
  } catch (erro) {
    if (erro.name === 'AbortError') {
      throw new Error(`sem resposta em ${Math.round(tempoLimite / 1000)} s (tempo esgotado)`);
    }
    if (erro instanceof TypeError) {
      // é assim que o fetch avisa que nem conseguiu conectar
      throw new Error('não foi possível conectar (container parado?)');
    }
    throw erro;
  } finally {
    clearTimeout(temporizador);
  }
}

// ---------------------------------------------------------------------------
// CONSOLE DE EVENTOS
// ---------------------------------------------------------------------------

// monta a linha com textContent (e não innerHTML): mensagem com dado da API
// nunca é interpretada como HTML aqui
function anotarNoRegistro(mensagem, tipo = 'info', origem) {
  const lista = document.getElementById('registro-eventos');
  if (!lista) return;

  const linha = document.createElement('li');
  linha.className = 'registro-linha';
  linha.dataset.tipo = tipo;

  const hora = document.createElement('time');
  hora.className = 'registro-hora';
  hora.textContent = horaAgora();
  linha.appendChild(hora);

  if (origem && CARTOES[origem]) {
    const etiqueta = document.createElement('span');
    etiqueta.className = `registro-origem banco-${origem}`;
    etiqueta.textContent = CARTOES[origem].nome;
    linha.appendChild(etiqueta);
  }

  const texto = document.createElement('span');
  texto.className = 'registro-texto';
  texto.textContent = mensagem;
  linha.appendChild(texto);

  lista.prepend(linha);
  // só as 15 mais recentes: o console não cresce sem fim durante a apresentação
  while (lista.children.length > MAXIMO_LINHAS_REGISTRO) {
    lista.lastElementChild.remove();
  }
}

// ---------------------------------------------------------------------------
// PEDAÇOS DE TELA REAPROVEITADOS PELOS TRÊS CARTÕES
// ---------------------------------------------------------------------------

// troca o número e dá um "pulinho" nele se mudou desde a última leitura
function definirNumero(id, valor) {
  const elemento = document.getElementById(id);
  if (!elemento) return;
  const texto = formatarNumero(valor);
  if (elemento.textContent === texto) return;
  const jaTinhaValor = elemento.dataset.lido === 'sim';
  elemento.textContent = texto;
  elemento.dataset.lido = 'sim';
  if (jaTinhaValor) reiniciarAnimacao(elemento, 'numero-mudou', 900);
}

function definirTexto(id, texto) {
  const elemento = document.getElementById(id);
  if (elemento) elemento.textContent = texto;
}

function preencherLista(id, html) {
  const elemento = document.getElementById(id);
  if (elemento) elemento.innerHTML = html;
}

function itemVazio(mensagem) {
  return `<li class="vazio">${escaparHtml(mensagem)}</li>`;
}

function itemComBarra(rotulo, valor, maximo, sufixo) {
  return `
    <li class="dado-barra">
      <span class="dado-barra-topo">
        <span class="dado-titulo">${escaparHtml(rotulo)}</span>
        <span class="dado-extra">${escaparHtml(formatarNumero(valor))}${escaparHtml(sufixo)}</span>
      </span>
      <span class="barra-trilho"><span class="barra-preenchida" style="width:${percentual(valor, maximo)}%"></span></span>
    </li>`;
}

// ---------------------------------------------------------------------------
// CARTÃO DO POSTGRESQL (servico-jogadores)
// ---------------------------------------------------------------------------

// o ranking do PostgreSQL só conhece o jogoId (o catálogo mora no Mongo).
// Em vez de N chamadas, uma só com ?ids=a,b,c — o clássico jeito de fugir do N+1.
// Se o acervo estiver fora, devolve null e o ranking aparece só com os ids.
async function buscarNomesDosJogos(ids) {
  const nomes = new Map();
  if (ids.length === 0) return nomes;
  try {
    const lista = ids.map(encodeURIComponent).join(',');
    const jogos = await buscarJson(`${API.acervo}/jogos?ids=${lista}`);
    for (const jogo of Array.isArray(jogos) ? jogos : []) {
      nomes.set(String(jogo._id || jogo.id), jogo.nome);
    }
    return nomes;
  } catch (_) {
    return null;
  }
}

function desenharUltimosJogadores(jogadores) {
  if (jogadores.length === 0) {
    preencherLista('pg-ultimos', itemVazio('Ninguém cadastrado ainda. Use "Cadastrar jogador de teste".'));
    return;
  }
  preencherLista('pg-ultimos', jogadores.map((jogador) => `
    <li class="dado-linha">
      <span class="dado-principal">
        <span class="dado-titulo">${escaparHtml(jogador.nome)}</span>
        <span class="dado-sub">${escaparHtml(jogador.email)}</span>
      </span>
      <span class="dado-extra">${escaparHtml(tempoRelativo(jogador.criadoEm))}</span>
    </li>`).join(''));
}

function desenharRanking(ranking, nomes) {
  if (ranking.length === 0) {
    preencherLista('pg-ranking', itemVazio('Nenhuma visualização ainda. Use "Simular visualização".'));
    return;
  }
  preencherLista('pg-ranking', ranking.map((item, indice) => {
    let nome = nomes && nomes.get(String(item.jogoId));
    let classeExtra = '';
    if (!nome) {
      // sem nome = acervo fora do ar (nomes === null) ou jogo já apagado do Mongo
      nome = nomes ? `jogo removido (${idCurto(item.jogoId)})` : `jogo ${idCurto(item.jogoId)}`;
      classeExtra = ' dado-sem-nome';
    }
    const posicao = indice + 1;
    return `
      <li class="dado-linha">
        <span class="posicao-ranking posicao-${posicao}">${posicao}</span>
        <span class="dado-titulo${classeExtra}">${escaparHtml(nome)}</span>
        <span class="dado-extra">👁 ${escaparHtml(formatarNumero(item.visualizacoes))}</span>
      </li>`;
  }).join(''));
}

async function consultarPostgres() {
  const base = API.jogadores;
  // as três consultas saem juntas (em paralelo), não uma depois da outra
  const [respostaEstatisticas, jogadores, ranking] = await Promise.all([
    buscarJson(`${base}/estatisticas`),
    buscarJson(`${base}/jogadores`),
    buscarJson(`${base}/ranking?limite=5`)
  ]);

  const estatisticas = respostaEstatisticas || {};
  const listaRanking = Array.isArray(ranking) ? ranking : [];
  const nomes = await buscarNomesDosJogos(listaRanking.map((item) => item.jogoId));

  definirNumero('pg-jogadores', estatisticas.jogadores);
  definirNumero('pg-visualizacoes', estatisticas.visualizacoes);
  definirNumero('pg-favoritos', estatisticas.favoritos);
  // a rota já devolve do mais novo pro mais velho, então os 5 primeiros bastam
  desenharUltimosJogadores(Array.isArray(jogadores) ? jogadores.slice(0, 5) : []);
  desenharRanking(listaRanking, nomes);

  return [estatisticas.jogadores, estatisticas.visualizacoes, estatisticas.favoritos];
}

// ---------------------------------------------------------------------------
// CARTÃO DO MONGODB (servico-acervo)
// ---------------------------------------------------------------------------

function desenharCategorias(porCategoria) {
  if (porCategoria.length === 0) {
    preencherLista('mg-categorias-lista', itemVazio('Acervo vazio. Rode o seed ou cadastre um jogo de teste.'));
    return;
  }
  const maior = Math.max(...porCategoria.map((item) => Number(item.total) || 0));
  preencherLista('mg-categorias-lista', porCategoria
    .map((item) => itemComBarra(item.categoria || 'Sem categoria', item.total, maior, ''))
    .join(''));
}

function desenharUltimosJogos(jogos) {
  if (jogos.length === 0) {
    preencherLista('mg-ultimos', itemVazio('Nenhum jogo no acervo ainda.'));
    return;
  }
  preencherLista('mg-ultimos', jogos.map((jogo) => `
    <li class="dado-linha">
      <span class="dado-principal">
        <span class="dado-titulo">${escaparHtml(jogo.nome)}</span>
        <span class="dado-sub">${escaparHtml(jogo.categoria || 'Sem categoria')}</span>
      </span>
      <span class="dado-extra">${escaparHtml(tempoRelativo(jogo.criadoEm))}</span>
    </li>`).join(''));
}

async function consultarMongo() {
  const base = API.acervo;
  const [respostaEstatisticas, ultimos] = await Promise.all([
    buscarJson(`${base}/estatisticas`),
    buscarJson(`${base}/jogos?limite=5`)
  ]);

  const estatisticas = respostaEstatisticas || {};
  const porCategoria = Array.isArray(estatisticas.porCategoria) ? estatisticas.porCategoria : [];

  definirNumero('mg-total', estatisticas.total);
  definirNumero('mg-categorias', porCategoria.length);
  // o $group já vem ordenado por total desc, então a primeira é a maior
  definirTexto('mg-maior', porCategoria.length ? (porCategoria[0].categoria || 'Sem categoria') : '—');
  desenharCategorias(porCategoria);
  desenharUltimosJogos(Array.isArray(ultimos) ? ultimos : []);

  // categoria entra na assinatura: editar a categoria de um jogo não muda o total,
  // mas muda a distribuição — e isso também merece piscar
  return [estatisticas.total, ...porCategoria.map((item) => `${item.categoria}:${item.total}`)];
}

// ---------------------------------------------------------------------------
// CARTÃO DO NEO4J (servico-afinidades)
// ---------------------------------------------------------------------------

function desenharMecanicasPopulares(populares) {
  if (populares.length === 0) {
    preencherLista('neo-populares', itemVazio('Grafo vazio. Clique em "Reconstruir grafo".'));
    return;
  }
  const maior = Math.max(...populares.map((item) => Number(item.totalJogos) || 0));
  preencherLista('neo-populares', populares
    .map((item) => itemComBarra(
      capitalizar(item.mecanica),
      item.totalJogos,
      maior,
      Number(item.totalJogos) === 1 ? ' jogo' : ' jogos'
    ))
    .join(''));
}

async function consultarNeo4j() {
  const base = API.afinidades;
  const [respostaResumo, populares] = await Promise.all([
    buscarJson(`${base}/grafo/resumo`),
    buscarJson(`${base}/mecanicas/populares?limite=8`)
  ]);

  const resumo = respostaResumo || {};

  definirNumero('neo-jogos', resumo.jogos);
  definirNumero('neo-mecanicas', resumo.mecanicas);
  definirNumero('neo-designers', resumo.designers);
  definirNumero('neo-relacoes', resumo.relacoes);
  desenharMecanicasPopulares(Array.isArray(populares) ? populares : []);

  return [resumo.jogos, resumo.mecanicas, resumo.designers, resumo.relacoes];
}

// ---------------------------------------------------------------------------
// STATUS, OFFLINE E "PISCADA" DOS CARTÕES
// ---------------------------------------------------------------------------

const CONSULTAS = {
  postgres: consultarPostgres,
  mongo: consultarMongo,
  neo4j: consultarNeo4j
};

// o que mostrar em cada cartão quando o serviço não responde
const CAMPOS_OFFLINE = {
  postgres: { numeros: ['pg-jogadores', 'pg-visualizacoes', 'pg-favoritos'], listas: ['pg-ultimos', 'pg-ranking'] },
  mongo: { numeros: ['mg-total', 'mg-categorias', 'mg-maior'], listas: ['mg-categorias-lista', 'mg-ultimos'] },
  neo4j: { numeros: ['neo-jogos', 'neo-mecanicas', 'neo-designers', 'neo-relacoes'], listas: ['neo-populares'] }
};

function pintarLuz(chave, estado, descricao) {
  const luz = document.getElementById(CARTOES[chave].idLuz);
  if (!luz) return;
  luz.dataset.estado = estado;
  luz.title = descricao;
  luz.setAttribute('aria-label', descricao);
}

function mostrarOnline(chave, milissegundos) {
  const cartao = CARTOES[chave];
  const elemento = document.getElementById(cartao.idCartao);
  if (elemento) elemento.classList.remove('fora-do-ar');
  pintarLuz(chave, 'online', `Online — consultas do cartão levaram ${milissegundos} ms`);
  definirTexto(cartao.idTempo, `⏱ ${milissegundos} ms`);

  if (cartao.online === false) {
    anotarNoRegistro(`${cartao.nome} voltou a responder.`, 'sucesso', chave);
  }
  cartao.online = true;
}

function mostrarOffline(chave, erro) {
  const cartao = CARTOES[chave];
  const mensagem = (erro && erro.message) || 'erro desconhecido';
  const elemento = document.getElementById(cartao.idCartao);
  if (elemento) elemento.classList.add('fora-do-ar');
  pintarLuz(chave, 'offline', `Offline: ${mensagem}`);
  definirTexto(cartao.idTempo, '');

  const campos = CAMPOS_OFFLINE[chave];
  for (const id of campos.numeros) {
    const numero = document.getElementById(id);
    if (numero) {
      numero.textContent = '—';
      numero.dataset.lido = 'nao';
    }
  }
  const aviso = `<li class="dado-offline">Sem resposta do serviço: ${escaparHtml(mensagem)}</li>`;
  for (const id of campos.listas) preencherLista(id, aviso);

  // só avisa no console na transição (ou na primeira leitura), senão
  // ele encheria de "offline" repetido a cada 3 s
  if (cartao.online !== false) {
    anotarNoRegistro(`${cartao.nome} está offline: ${mensagem}`, 'erro', chave);
  }
  cartao.online = false;
}

// pisca o cartão quando algum número mudou desde a última leitura bem-sucedida
// (a primeira leitura só guarda a referência, senão tudo piscaria ao abrir a página)
function verificarMudanca(chave, numeros) {
  const cartao = CARTOES[chave];
  const assinatura = JSON.stringify(numeros);
  if (cartao.assinatura !== null && cartao.assinatura !== assinatura) {
    reiniciarAnimacao(document.getElementById(cartao.idCartao), 'cartao-piscando', 1000);
  }
  cartao.assinatura = assinatura;
}

async function atualizarCartao(chave) {
  const inicio = performance.now();
  try {
    const numeros = await CONSULTAS[chave]();
    mostrarOnline(chave, Math.round(performance.now() - inicio));
    verificarMudanca(chave, numeros);
    return true;
  } catch (erro) {
    mostrarOffline(chave, erro);
    throw erro; // o allSettled lá em cima conta isso como "rejected"
  }
}

function atualizarIndicador(totalOnline, totalBancos) {
  const indicador = document.getElementById('indicador-vivo');
  if (!indicador) return;
  let saude = 'tudo-ok';
  if (totalOnline === 0) saude = 'fora';
  else if (totalOnline < totalBancos) saude = 'parcial';
  indicador.dataset.saude = saude;
  indicador.title = `${totalOnline} de ${totalBancos} bancos respondendo`;
  definirTexto('indicador-texto', `Atualizado às ${horaAgora()}`);
}

// ---------------------------------------------------------------------------
// RODADA DE ATUALIZAÇÃO
// ---------------------------------------------------------------------------

async function atualizar() {
  // se a rodada anterior ainda não voltou, pula este tique (não empilha requisições)
  if (rodadaEmAndamento) return;
  rodadaEmAndamento = true;
  try {
    const chaves = Object.keys(CONSULTAS);
    // allSettled e não all: um banco fora não pode cancelar a atualização dos outros
    const resultados = await Promise.allSettled(chaves.map(atualizarCartao));
    const totalOnline = resultados.filter((resultado) => resultado.status === 'fulfilled').length;
    atualizarIndicador(totalOnline, chaves.length);
  } catch (erro) {
    // não deveria acontecer (allSettled não rejeita), mas fica registrado se acontecer
    console.error('Falha inesperada na rodada de atualização:', erro);
  } finally {
    rodadaEmAndamento = false;
    if (rodadaExtraPedida) {
      rodadaExtraPedida = false;
      setTimeout(atualizar, 0);
    }
  }
}

// usado depois dos botões de demonstração: atualiza já, sem esperar o próximo tique.
// Se tiver uma rodada no meio do caminho, só marca pra rodar de novo quando ela acabar.
function atualizarAgora() {
  if (rodadaEmAndamento) {
    rodadaExtraPedida = true;
    return;
  }
  atualizar();
}

// ---------------------------------------------------------------------------
// AÇÕES DE DEMONSTRAÇÃO
// ---------------------------------------------------------------------------

async function cadastrarJogadorTeste() {
  // até 3 tentativas: se o número sorteado já virou e-mail cadastrado (409), sorteia outro
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const numero = numeroAleatorio(1000, 9999);
    const corpo = {
      nome: `Jogador Teste ${numero}`,
      email: `teste.${numero}@ludoteca.dev`,
      senha: 'teste123'
    };
    try {
      const resposta = await buscarJson(`${API.jogadores}/cadastro`, { metodo: 'POST', corpo });
      const jogador = (resposta && resposta.jogador) || corpo;
      anotarNoRegistro(
        `INSERT em jogadores: "${jogador.nome}" (id ${jogador.id ?? '?'}). A senha foi gravada só como hash bcrypt.`,
        'sucesso', 'postgres'
      );
      return;
    } catch (erro) {
      if (erro.status === 409 && tentativa < 3) continue;
      anotarNoRegistro(`Falha ao cadastrar jogador: ${erro.message}`, 'erro', 'postgres');
      return;
    }
  }
}

async function cadastrarJogoTeste() {
  const corpo = {
    nome: `Protótipo ${numeroAleatorio(100, 999)}`,
    categoria: sortearUm(CATEGORIAS),
    mecanicas: embaralhar(MECANICAS_DO_SEED).slice(0, numeroAleatorio(2, 3)),
    jogadores: { min: 2, max: 4 },
    duracaoMinutos: 30
  };
  try {
    const jogo = await buscarJson(`${API.acervo}/jogos`, { metodo: 'POST', corpo });
    const mecanicas = Array.isArray(jogo && jogo.mecanicas) ? jogo.mecanicas : corpo.mecanicas;
    anotarNoRegistro(
      `Documento "${(jogo && jogo.nome) || corpo.nome}" (${(jogo && jogo.categoria) || corpo.categoria}) inserido na coleção jogos — mecânicas: ${mecanicas.join(', ')}.`,
      'sucesso', 'mongo'
    );
    // o próprio acervo avisa o grafo (PUT /grafo/jogos/:id) sem a gente fazer nada aqui
    anotarNoRegistro('O acervo avisou o grafo sozinho; o nó do jogo e suas ligações aparecem no próximo tique.', 'info', 'neo4j');
  } catch (erro) {
    anotarNoRegistro(`Falha ao cadastrar jogo: ${erro.message}`, 'erro', 'mongo');
  }
}

async function simularVisualizacao() {
  // 1º passo: sortear um jogo que exista de verdade no acervo
  let jogo;
  try {
    const jogos = await buscarJson(`${API.acervo}/jogos?limite=100`);
    if (!Array.isArray(jogos) || jogos.length === 0) {
      anotarNoRegistro('O acervo está vazio. Rode o seed (npm run seed no acervo-api) antes de simular.', 'erro', 'mongo');
      return;
    }
    jogo = sortearUm(jogos);
  } catch (erro) {
    anotarNoRegistro(`Não deu pra sortear um jogo do acervo: ${erro.message}`, 'erro', 'mongo');
    return;
  }

  // 2º passo: registrar a visualização (anônima, já que o monitor não faz login)
  try {
    await buscarJson(`${API.jogadores}/visualizacoes`, { metodo: 'POST', corpo: { jogoId: jogo._id } });
    anotarNoRegistro(
      `+1 visualização de "${jogo.nome}" gravada. O ranking é um COUNT/GROUP BY em cima do índice por jogo_id.`,
      'sucesso', 'postgres'
    );
  } catch (erro) {
    anotarNoRegistro(`Falha ao registrar visualização: ${erro.message}`, 'erro', 'postgres');
  }
}

async function reconstruirGrafo() {
  anotarNoRegistro('Pedindo pro grafo se reconstruir a partir do acervo…', 'info', 'neo4j');
  try {
    const resultado = await buscarJson(`${API.afinidades}/sync`, { metodo: 'POST', tempoLimite: TEMPO_LIMITE_SYNC_MS });
    anotarNoRegistro(
      `Grafo recriado em lote (UNWIND): ${formatarNumero(resultado.jogos)} jogos, ${formatarNumero(resultado.mecanicas)} mecânicas, ` +
      `${formatarNumero(resultado.designers)} designers e ${formatarNumero(resultado.relacoes)} relações.`,
      'sucesso', 'neo4j'
    );
  } catch (erro) {
    anotarNoRegistro(`Falha ao reconstruir o grafo: ${erro.message}`, 'erro', 'neo4j');
  }
}

const ACOES = {
  'cadastrar-jogador': cadastrarJogadorTeste,
  'cadastrar-jogo': cadastrarJogoTeste,
  'simular-visualizacao': simularVisualizacao,
  'reconstruir-grafo': reconstruirGrafo
};

async function executarAcao(botao) {
  const acao = ACOES[botao.dataset.acao];
  if (!acao || botao.disabled) return;
  // trava o botão enquanto a requisição está no ar: clique duplo não vira cadastro duplo
  botao.disabled = true;
  botao.setAttribute('aria-busy', 'true');
  try {
    await acao();
  } catch (erro) {
    anotarNoRegistro(`Erro inesperado: ${erro.message}`, 'erro');
  } finally {
    botao.disabled = false;
    botao.removeAttribute('aria-busy');
    atualizarAgora();
  }
}

// ---------------------------------------------------------------------------
// RODAPÉ: COPIAR CONSULTAS CYPHER
// ---------------------------------------------------------------------------

async function copiarConsulta(botao) {
  const origem = document.getElementById(botao.dataset.copiar);
  if (!origem) return;
  const textoOriginal = botao.textContent;
  try {
    // clipboard só existe em contexto seguro (https ou localhost)
    await navigator.clipboard.writeText(origem.textContent.trim());
    botao.textContent = 'Copiada! ✓';
  } catch (_) {
    // plano B: deixa o texto selecionado pra pessoa dar Ctrl+C
    const selecao = window.getSelection();
    const intervalo = document.createRange();
    intervalo.selectNodeContents(origem);
    selecao.removeAllRanges();
    selecao.addRange(intervalo);
    botao.textContent = 'Selecionada — Ctrl+C';
  }
  setTimeout(() => { botao.textContent = textoOriginal; }, 1800);
}

// se o config.js apontar pra outro host, o link do Neo4j Browser acompanha
function ajustarLinkNeo4jBrowser() {
  const link = document.getElementById('link-neo4j-browser');
  if (!link) return;
  try {
    const host = new URL(API.afinidades).hostname;
    const endereco = `http://${host}:7474`;
    link.href = endereco;
    link.textContent = endereco;
  } catch (_) {
    // URL estranha no config: mantém o localhost que já está no HTML
  }
}

// ---------------------------------------------------------------------------
// INÍCIO
// ---------------------------------------------------------------------------

function iniciarMonitor() {
  document.querySelectorAll('.acao-demo[data-acao]').forEach((botao) => {
    botao.addEventListener('click', () => executarAcao(botao));
  });

  document.querySelectorAll('[data-copiar]').forEach((botao) => {
    botao.addEventListener('click', () => copiarConsulta(botao));
  });

  const botaoLimpar = document.getElementById('botao-limpar-registro');
  if (botaoLimpar) {
    botaoLimpar.addEventListener('click', () => {
      document.getElementById('registro-eventos').replaceChildren();
      anotarNoRegistro('Console limpo.', 'info');
    });
  }

  ajustarLinkNeo4jBrowser();

  if (!window.LUDOTECA_API) {
    anotarNoRegistro('config.js não carregou; usando os endereços padrão das APIs (localhost).', 'erro');
  }
  anotarNoRegistro(`Monitor iniciado. Consultando os 3 bancos a cada ${INTERVALO_ATUALIZACAO_MS / 1000} s.`, 'info');

  atualizar();
  setInterval(atualizar, INTERVALO_ATUALIZACAO_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', iniciarMonitor);
} else {
  iniciarMonitor();
}
