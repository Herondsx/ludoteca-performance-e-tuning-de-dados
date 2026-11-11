/* =============================================================================
   ludoteca.js — SPA da Ludoteca (catálogo de jogos de tabuleiro)
   -----------------------------------------------------------------------------
   Uma página só, com roteador por hash (#/jogos, #/jogos/:id ...). Escolhemos
   hash router porque o front é servido por um nginx estático: com "#" o
   servidor nunca recebe a rota, então não precisa configurar fallback nenhum.

   O app conversa com 3 APIs, cada uma dona de um banco diferente:
     - jogadores  (PostgreSQL) → conta, favoritos, histórico, ranking
     - acervo     (MongoDB)    → os jogos em si (documentos)
     - afinidades (Neo4j)      → "jogos parecidos" percorrendo o grafo

   Regras que a gente seguiu aqui dentro:
     * TODO valor que vem de API e vai pro innerHTML passa por escaparHtml()
       (inclusive dentro de atributo). Nada de onclick inline: os cliques são
       tratados por delegação de eventos lendo data-atributos.
     * Quando a tela precisa juntar dado de dois bancos (ranking, favoritos,
       histórico), buscamos os jogos no acervo em LOTE (?ids=a,b,c) — uma ida
       só ao Mongo em vez de N requisições, que é a parte de "tuning" do front.
   ============================================================================= */
'use strict';

// -----------------------------------------------------------------------------
// 1. Configuração e constantes
// -----------------------------------------------------------------------------

// config.js é carregado antes; o fallback só existe pra não quebrar tudo se ele faltar
const API = window.LUDOTECA_API || {
  jogadores: 'http://localhost:4001',
  acervo: 'http://localhost:4002',
  afinidades: 'http://localhost:4003'
};

const CHAVE_JOGADOR = 'ludo_jogador';
const CHAVE_TOKEN = 'ludo_token';

// mesmo formato que o servico-jogadores valida: ObjectId do Mongo (24 hex)
const REGEX_ID_JOGO = /^[a-f0-9]{24}$/i;

// a API do acervo aceita no máximo 100 ids por chamada em lote
const MAXIMO_IDS_POR_LOTE = 100;

// tabela de capas geradas: cada categoria tem um emoji e um gradiente próprio
const CATEGORIAS = [
  { nome: 'Estratégia',  emoji: '♟️', de: '#1f4d3a', para: '#3f7d5c' },
  { nome: 'Família',     emoji: '🏡', de: '#e4572e', para: '#f3a712' },
  { nome: 'Cooperativo', emoji: '🤝', de: '#2e86ab', para: '#5fb0d6' },
  { nome: 'Party',       emoji: '🎉', de: '#b8336a', para: '#e56b9f' },
  { nome: 'Cartas',      emoji: '🃏', de: '#6a4c93', para: '#9d7cc9' },
  { nome: 'Abstrato',    emoji: '🔷', de: '#2b2d42', para: '#5c6079' },
  { nome: 'Outros',      emoji: '🎲', de: '#6b705c', para: '#a5a58d' }
];
const CATEGORIA_PADRAO = CATEGORIAS[CATEGORIAS.length - 1];

const TAMANHOS_CAPA = ['mini', 'card', 'grande'];

// -----------------------------------------------------------------------------
// 2. Helpers de texto/formatação
// -----------------------------------------------------------------------------

/** Escapa qualquer valor antes de ir pro HTML (serve pra texto e pra atributo entre aspas). */
function escaparHtml(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor).replace(/[&<>"'`]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
  }[c]));
}

/** O grafo guarda mecânica em minúsculas (pra agrupar "Draft" e "draft"); aqui a gente devolve a maiúscula. */
function capitalizar(texto) {
  const limpo = String(texto ?? '').trim();
  if (!limpo) return '';
  return limpo.charAt(0).toLocaleUpperCase('pt-BR') + limpo.slice(1);
}

function numeroOuNulo(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/** "2–4", "2" (quando min = max), "2+" ou "até 4", dependendo do que o documento tiver. */
function faixaJogadores(jogo) {
  const faixa = (jogo && jogo.jogadores) || {};
  const min = numeroOuNulo(faixa.min);
  const max = numeroOuNulo(faixa.max);
  if (min && max) return min === max ? String(min) : `${min}–${max}`;
  if (min) return `${min}+`;
  if (max) return `até ${max}`;
  return '';
}

function formatarComplexidade(valor) {
  const n = numeroOuNulo(valor);
  return n === null ? '' : n.toFixed(1);
}

function rotuloComplexidade(valor) {
  const n = numeroOuNulo(valor);
  if (n === null) return '';
  if (n < 2) return 'leve';
  if (n < 3) return 'média';
  if (n < 4) return 'pesada';
  return 'muito pesada';
}

/** dd/mm hh:mm no fuso do navegador */
function formatarDataHora(iso) {
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(data.getDate())}/${p(data.getMonth() + 1)} ${p(data.getHours())}:${p(data.getMinutes())}`;
}

function formatarData(iso) {
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(data.getDate())}/${p(data.getMonth() + 1)}/${data.getFullYear()}`;
}

function plural(n, singular, varios) {
  return `${Number(n).toLocaleString('pt-BR')} ${n === 1 ? singular : varios}`;
}

function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || 'jogador';
}

function comoLista(valor) {
  return Array.isArray(valor) ? valor.filter((item) => item !== null && item !== undefined && item !== '') : [];
}

/** Só deixa passar URL http(s) — evita "javascript:" e afins num src. */
function urlSegura(url) {
  if (typeof url !== 'string') return '';
  const limpa = url.trim();
  return /^https?:\/\//i.test(limpa) ? limpa : '';
}

function infoCategoria(nome) {
  return CATEGORIAS.find((c) => c.nome === nome) || CATEGORIA_PADRAO;
}

function hostDe(url) {
  try { return new URL(url).host; } catch { return url; }
}

function definirTitulo(texto) {
  document.title = `Ludoteca — ${texto}`;
}

// -----------------------------------------------------------------------------
// 3. Pedacinhos de HTML reaproveitados
// -----------------------------------------------------------------------------

function hrefJogo(id) {
  return `#/jogos/${encodeURIComponent(String(id))}`;
}

function montarHashCatalogo({ q = '', categoria = '', jogadores = '' } = {}) {
  const parametros = new URLSearchParams();
  if (q) parametros.set('q', q);
  if (categoria) parametros.set('categoria', categoria);
  if (jogadores) parametros.set('jogadores', jogadores);
  const texto = parametros.toString();
  return texto ? `#/jogos?${texto}` : '#/jogos';
}

/**
 * Capa do jogo. Sempre desenha a capa gerada (gradiente + emoji + nome) e, se o
 * documento tiver `imagem`, coloca o <img> por cima. Se a imagem quebrar, um
 * listener global de "error" remove o <img> e a capa gerada aparece — assim não
 * precisamos de onerror inline.
 */
function capaHtml(jogo, tamanho = 'card') {
  const formato = TAMANHOS_CAPA.includes(tamanho) ? tamanho : 'card';
  const cat = infoCategoria(jogo && jogo.categoria);
  const nome = (jogo && jogo.nome) || 'Jogo sem nome';
  const imagem = urlSegura(jogo && jogo.imagem);
  return `
    <div class="capa capa-${formato}" style="--capa-de:${cat.de};--capa-para:${cat.para}" role="img" aria-label="Capa de ${escaparHtml(nome)}">
      <span class="capa-emoji" aria-hidden="true">${cat.emoji}</span>
      ${formato === 'mini' ? '' : `<span class="capa-nome" aria-hidden="true">${escaparHtml(nome)}</span>`}
      ${imagem ? `<img class="capa-img" src="${escaparHtml(imagem)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
    </div>`;
}

function chipCategoriaHtml(nomeCategoria) {
  const cat = infoCategoria(nomeCategoria);
  const rotulo = nomeCategoria || cat.nome;
  return `<span class="chip chip-categoria" style="--cor:${cat.de}">${cat.emoji} ${escaparHtml(rotulo)}</span>`;
}

function metaJogo(jogo) {
  const partes = [];
  const faixa = faixaJogadores(jogo);
  if (faixa) partes.push(`👥 ${faixa}`);
  const duracao = numeroOuNulo(jogo.duracaoMinutos);
  if (duracao) partes.push(`⏱ ${duracao} min`);
  const complexidade = formatarComplexidade(jogo.complexidade);
  if (complexidade) partes.push(`🧠 ${complexidade}`);
  return partes.join(' · ');
}

/** Card do grid. `rodapeHtml` já vem montado (e escapado) por quem chama. */
function cartaoJogoHtml(jogo, rodapeHtml = '') {
  const meta = metaJogo(jogo);
  return `
    <a class="cartao-jogo" href="${escaparHtml(hrefJogo(jogo._id))}">
      ${capaHtml(jogo, 'card')}
      <div class="cartao-corpo">
        ${chipCategoriaHtml(jogo.categoria)}
        <h3 class="cartao-titulo">${escaparHtml(jogo.nome)}</h3>
        ${meta ? `<p class="cartao-meta">${escaparHtml(meta)}</p>` : ''}
        ${rodapeHtml}
      </div>
    </a>`;
}

function carregandoHtml(texto) {
  return `
    <div class="carregando" role="status">
      <span class="roleta" aria-hidden="true"></span>
      <span>${escaparHtml(texto)}</span>
    </div>`;
}

/** Estado vazio. `acaoHtml` é HTML montado aqui no front (confiável). */
function vazioHtml({ icone = '🎲', titulo, texto = '', acaoHtml = '' }) {
  return `
    <div class="vazio">
      <span class="vazio-icone" aria-hidden="true">${icone}</span>
      <h3>${escaparHtml(titulo)}</h3>
      ${texto ? `<p>${escaparHtml(texto)}</p>` : ''}
      ${acaoHtml}
    </div>`;
}

function erroHtml(titulo, erro) {
  const mensagem = (erro && erro.message) || 'Erro desconhecido';
  return `
    <div class="vazio vazio-erro" role="alert">
      <span class="vazio-icone" aria-hidden="true">⚠️</span>
      <h3>${escaparHtml(titulo)}</h3>
      <p>${escaparHtml(mensagem)}</p>
      <button type="button" class="botao botao-contorno botao-pequeno" data-acao="recarregar">↻ Tentar de novo</button>
    </div>`;
}

function barraComplexidadeHtml(valor) {
  const n = numeroOuNulo(valor);
  if (n === null) return '—';
  // 5 gomos; cada um preenche de 0 a 100% (ex.: 2.3 → 100, 100, 30, 0, 0)
  const gomos = [0, 1, 2, 3, 4].map((i) => {
    const preenchido = Math.round(Math.min(Math.max(n - i, 0), 1) * 100);
    return `<span class="gomo" style="--p:${preenchido}%"></span>`;
  }).join('');
  return `
    <div class="barra-complexidade" role="meter" aria-valuemin="1" aria-valuemax="5" aria-valuenow="${n}" aria-label="Complexidade ${formatarComplexidade(n)} de 5">${gomos}</div>
    <span class="complexidade-texto">${formatarComplexidade(n)} / 5 · ${rotuloComplexidade(n)}</span>`;
}

// -----------------------------------------------------------------------------
// 4. Sessão (localStorage)
// -----------------------------------------------------------------------------

function lerSessaoSalva() {
  try {
    const token = localStorage.getItem(CHAVE_TOKEN);
    const jogador = JSON.parse(localStorage.getItem(CHAVE_JOGADOR) || 'null');
    if (token && jogador && typeof jogador === 'object') return { token, jogador };
  } catch {
    // navegador bloqueando storage ou JSON corrompido: começa deslogado e pronto
  }
  return { token: null, jogador: null };
}

let sessao = lerSessaoSalva();

function salvarSessao(jogador, token) {
  sessao = { jogador, token };
  try {
    localStorage.setItem(CHAVE_JOGADOR, JSON.stringify(jogador));
    localStorage.setItem(CHAVE_TOKEN, token);
  } catch {
    // sem storage a sessão vale só enquanto a aba estiver aberta
  }
}

function limparSessao() {
  sessao = { jogador: null, token: null };
  try {
    localStorage.removeItem(CHAVE_JOGADOR);
    localStorage.removeItem(CHAVE_TOKEN);
  } catch {
    // nada a fazer
  }
}

function estaLogado() {
  return Boolean(sessao.token && sessao.jogador);
}

// -----------------------------------------------------------------------------
// 5. Acesso às APIs
// -----------------------------------------------------------------------------

/**
 * fetch com as manias do projeto:
 *  - manda JSON e o Bearer token quando tem sessão;
 *  - erro de API vem como { erro }, então a mensagem é lida daí;
 *  - 401 numa rota que exige login = token morto → limpa sessão e manda pro #/entrar.
 * Opções extras (além das do fetch): exigeLogin (bool) e redirecionar (bool, padrão true).
 */
async function requisicao(url, opcoes = {}) {
  const { exigeLogin = false, redirecionar = true, headers: headersExtras, ...opcoesFetch } = opcoes;
  const headers = { 'Content-Type': 'application/json', ...(headersExtras || {}) };
  if (sessao.token) headers.Authorization = `Bearer ${sessao.token}`;

  let resposta;
  try {
    resposta = await fetch(url, { ...opcoesFetch, headers });
  } catch {
    const erro = new Error(`Não consegui falar com ${hostDe(url)}. Esse serviço está no ar?`);
    erro.status = 0;
    throw erro;
  }

  // nem toda resposta tem corpo, então lê como texto e tenta converter
  let dados = null;
  try {
    const texto = await resposta.text();
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = null;
  }

  if (!resposta.ok) {
    const erro = new Error((dados && dados.erro) || `Erro ${resposta.status} em ${hostDe(url)}`);
    erro.status = resposta.status;

    if (resposta.status === 401 && exigeLogin) {
      limparSessao();
      atualizarCabecalho();
      if (redirecionar) {
        erro.sessaoExpirada = true;
        mostrarAviso('Sua sessão expirou. Entre de novo para continuar.', 'erro');
        irPara('#/entrar');
      }
    }
    throw erro;
  }
  return dados;
}

function corpoJson(metodo, dados) {
  return { method: metodo, body: JSON.stringify(dados) };
}

const api = {
  // --- jogadores (PostgreSQL) ---
  cadastrar: (dados) => requisicao(`${API.jogadores}/cadastro`, corpoJson('POST', dados)),
  entrar: (dados) => requisicao(`${API.jogadores}/login`, corpoJson('POST', dados)),
  registrarVisualizacao: (jogoId) => requisicao(`${API.jogadores}/visualizacoes`, corpoJson('POST', { jogoId })),
  ranking: (limite = 10) => requisicao(`${API.jogadores}/ranking?limite=${encodeURIComponent(limite)}`),
  favoritos: (redirecionar = true) => requisicao(`${API.jogadores}/favoritos`, { exigeLogin: true, redirecionar }),
  favoritar: (jogoId) => requisicao(`${API.jogadores}/favoritos/${encodeURIComponent(jogoId)}`, { method: 'POST', exigeLogin: true }),
  desfavoritar: (jogoId) => requisicao(`${API.jogadores}/favoritos/${encodeURIComponent(jogoId)}`, { method: 'DELETE', exigeLogin: true }),
  historico: () => requisicao(`${API.jogadores}/historico`, { exigeLogin: true }),

  // --- acervo (MongoDB) ---
  listarJogos: (filtros = {}) => {
    const parametros = new URLSearchParams();
    Object.entries(filtros).forEach(([chave, valor]) => {
      if (valor !== undefined && valor !== null && valor !== '') parametros.set(chave, valor);
    });
    const texto = parametros.toString();
    return requisicao(`${API.acervo}/jogos${texto ? `?${texto}` : ''}`);
  },
  buscarJogo: (id) => requisicao(`${API.acervo}/jogos/${encodeURIComponent(id)}`),
  criarJogo: (dados) => requisicao(`${API.acervo}/jogos`, corpoJson('POST', dados)),
  atualizarJogo: (id, dados) => requisicao(`${API.acervo}/jogos/${encodeURIComponent(id)}`, corpoJson('PUT', dados)),
  excluirJogo: (id) => requisicao(`${API.acervo}/jogos/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * Busca vários jogos de uma vez: GET /jogos?ids=a,b,c. Na prática é sempre UMA
   * chamada (ranking ≤ 50, histórico ≤ 20); só se alguém tiver mais de 100
   * favoritos é que a lista é quebrada em lotes, disparados em paralelo.
   */
  jogosPorIds: async (ids) => {
    const validos = [...new Set(comoLista(ids).map(String).filter((id) => REGEX_ID_JOGO.test(id)))];
    if (!validos.length) return [];
    const lotes = [];
    for (let i = 0; i < validos.length; i += MAXIMO_IDS_POR_LOTE) {
      lotes.push(validos.slice(i, i + MAXIMO_IDS_POR_LOTE));
    }
    const respostas = await Promise.all(lotes.map((lote) => requisicao(`${API.acervo}/jogos?ids=${lote.join(',')}`)));
    return respostas.flatMap((lista) => comoLista(lista));
  },

  // --- afinidades (Neo4j) ---
  similares: (jogoId) => requisicao(`${API.afinidades}/similares/${encodeURIComponent(jogoId)}`)
};

/**
 * Junta itens do Postgres ({jogoId, ...}) com os documentos do Mongo, mantendo
 * a ordem original. Jogo que foi apagado do acervo simplesmente some da lista.
 */
async function juntarComAcervo(itens) {
  const lista = comoLista(itens);
  if (!lista.length) return [];
  const jogos = await api.jogosPorIds(lista.map((item) => item.jogoId));
  const porId = new Map(jogos.map((jogo) => [String(jogo._id).toLowerCase(), jogo]));
  return lista
    .map((item) => ({ ...item, jogo: porId.get(String(item.jogoId).toLowerCase()) }))
    .filter((item) => item.jogo);
}

// -----------------------------------------------------------------------------
// 6. Aviso flutuante (toast)
// -----------------------------------------------------------------------------

let temporizadorAviso = null;

function mostrarAviso(texto, tipo = 'info') {
  const tipoSeguro = ['info', 'sucesso', 'erro'].includes(tipo) ? tipo : 'info';
  let elemento = document.getElementById('aviso');
  if (!elemento) {
    elemento = document.createElement('div');
    elemento.id = 'aviso';
    elemento.setAttribute('role', 'status');
    elemento.setAttribute('aria-live', 'polite');
    document.body.appendChild(elemento);
  }
  elemento.textContent = texto; // textContent: nada de HTML aqui
  elemento.className = `aviso aviso-${tipoSeguro}`;
  void elemento.offsetWidth; // força o reflow pra transição recomeçar
  elemento.classList.add('visivel');
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => elemento.classList.remove('visivel'), 3400);
}

// -----------------------------------------------------------------------------
// 7. Cabeçalho (menu + área da conta)
// -----------------------------------------------------------------------------

function secaoDoMenu(caminho) {
  if (caminho === '/') return 'inicio';
  if (caminho === '/jogos/novo') return 'novo';
  if (caminho === '/jogos' || caminho.startsWith('/jogos/')) return 'jogos';
  if (caminho === '/favoritos') return 'favoritos';
  if (caminho === '/historico') return 'historico';
  return '';
}

function atualizarCabecalho(caminho = lerHash().caminho) {
  const logado = estaLogado();
  const area = document.getElementById('area-conta');
  if (area) {
    area.innerHTML = logado
      ? `<span class="saudacao">Olá, <strong>${escaparHtml(primeiroNome(sessao.jogador.nome))}</strong></span>
         <button type="button" class="botao botao-contorno botao-pequeno" data-acao="sair">Sair</button>`
      : `<a class="botao botao-contorno botao-pequeno" href="#/entrar">Entrar</a>
         <a class="botao botao-primario botao-pequeno" href="#/cadastro">Criar conta</a>`;
  }

  document.querySelectorAll('[data-somente-logado]').forEach((link) => { link.hidden = !logado; });

  const secao = secaoDoMenu(caminho);
  document.querySelectorAll('.menu-link[data-rota]').forEach((link) => {
    const ativo = link.dataset.rota === secao;
    link.classList.toggle('ativo', ativo);
    if (ativo) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

// -----------------------------------------------------------------------------
// 8. Roteador
// -----------------------------------------------------------------------------

function lerHash() {
  const bruto = window.location.hash.replace(/^#/, '') || '/';
  const posicao = bruto.indexOf('?');
  let caminho = posicao >= 0 ? bruto.slice(0, posicao) : bruto;
  const busca = posicao >= 0 ? bruto.slice(posicao + 1) : '';
  if (!caminho.startsWith('/')) caminho = `/${caminho}`;
  if (caminho.length > 1) caminho = caminho.replace(/\/+$/, '') || '/';
  return { caminho, query: new URLSearchParams(busca) };
}

function decodificar(trecho) {
  try { return decodeURIComponent(trecho); } catch { return trecho; }
}

/** Navega pra um hash; se já estamos nele, só redesenha. */
function irPara(hash, substituir = false) {
  if (window.location.hash === hash) {
    executar(roteador);
    return;
  }
  if (substituir) window.location.replace(hash);
  else window.location.hash = hash;
}

const ROTAS = [
  { padrao: /^\/$/, tela: telaInicio },
  { padrao: /^\/jogos$/, tela: telaCatalogo },
  { padrao: /^\/jogos\/novo$/, tela: telaFormularioJogo, exigeLogin: true },
  { padrao: /^\/jogos\/([^/]+)\/editar$/, tela: telaFormularioJogo, exigeLogin: true },
  { padrao: /^\/jogos\/([^/]+)$/, tela: telaDetalhe },
  { padrao: /^\/favoritos$/, tela: telaFavoritos, exigeLogin: true },
  { padrao: /^\/historico$/, tela: telaHistorico, exigeLogin: true },
  { padrao: /^\/entrar$/, tela: telaEntrar, soDeslogado: true },
  { padrao: /^\/cadastro$/, tela: telaCadastro, soDeslogado: true }
];

// Cada navegação ganha um número. Se o usuário trocar de tela enquanto uma
// requisição ainda está no ar, a resposta atrasada vê que não é mais a "rodada"
// vigente e não sobrescreve a tela nova.
let rodadaAtual = 0;

async function roteador() {
  const rodada = ++rodadaAtual;
  const { caminho, query } = lerHash();
  const app = document.getElementById('app');
  atualizarCabecalho(caminho);
  window.scrollTo(0, 0);

  let rotaEncontrada = null;
  let partes = [];
  for (const rota of ROTAS) {
    const casamento = caminho.match(rota.padrao);
    if (casamento) {
      rotaEncontrada = rota;
      partes = casamento.slice(1).map(decodificar);
      break;
    }
  }

  if (!rotaEncontrada) {
    definirTitulo('Página não encontrada');
    app.innerHTML = vazioHtml({
      icone: '🧭',
      titulo: 'Essa página não existe',
      texto: 'O endereço pode ter sido digitado errado. Que tal voltar pro catálogo?',
      acaoHtml: '<a class="botao botao-primario" href="#/jogos">Ver os jogos</a>'
    });
    return;
  }

  if (rotaEncontrada.exigeLogin && !estaLogado()) {
    mostrarAviso('Entre na sua conta para acessar essa página.', 'info');
    irPara('#/entrar', true);
    return;
  }
  if (rotaEncontrada.soDeslogado && estaLogado()) {
    irPara('#/', true);
    return;
  }

  const contexto = { app, query, partes, vigente: () => rodada === rodadaAtual };
  try {
    await rotaEncontrada.tela(contexto);
  } catch (erro) {
    // rede de segurança: cada tela já trata os próprios erros, isso aqui é pro imprevisto
    console.error('Falha ao desenhar a tela:', erro);
    if (contexto.vigente() && !erro.sessaoExpirada) {
      app.innerHTML = erroHtml('Algo deu errado ao montar esta página', erro);
    }
  }
}

// -----------------------------------------------------------------------------
// 9. Telas
// -----------------------------------------------------------------------------

// ---- 9.1 Início ------------------------------------------------------------

async function telaInicio({ app, vigente }) {
  definirTitulo('Início');
  const logado = estaLogado();
  const pecas = [...CATEGORIAS, { emoji: '🧩', de: '#c4441f', para: '#e4572e' }, { emoji: '🏆', de: '#b7791f', para: '#f3a712' }];

  app.innerHTML = `
    <section class="heroi">
      <div>
        <span class="heroi-rotulo">Catálogo de jogos de tabuleiro</span>
        <h1>Bem-vindo à Ludoteca</h1>
        <p class="heroi-texto">
          Descubra jogos novos, guarde seus favoritos e veja o que a turma mais anda olhando.
          Por trás da mesa, cada tipo de dado mora no banco que combina com ele.
        </p>
        <div class="heroi-acoes">
          <a class="botao botao-primario botao-grande" href="#/jogos">Explorar o acervo</a>
          ${logado
            ? '<a class="botao botao-contorno botao-grande" href="#/jogos/novo">+ Cadastrar um jogo</a>'
            : '<a class="botao botao-contorno botao-grande" href="#/cadastro">Criar conta grátis</a>'}
        </div>
      </div>
      <div class="heroi-tabuleiro" aria-hidden="true">
        ${pecas.map((p) => `<span class="peca" style="--capa-de:${p.de};--capa-para:${p.para}">${p.emoji}</span>`).join('')}
      </div>
    </section>

    <section class="bancos" aria-label="Onde cada dado é guardado">
      <div class="banco banco-postgres">
        <span class="banco-icone" aria-hidden="true">🐘</span>
        <div>
          <strong>PostgreSQL</strong>
          <p>Contas, favoritos e cada visualização. Relacional: e-mail único, chaves estrangeiras e COUNT/GROUP BY pro ranking.</p>
        </div>
      </div>
      <div class="banco banco-mongo">
        <span class="banco-icone" aria-hidden="true">🍃</span>
        <div>
          <strong>MongoDB</strong>
          <p>O acervo. Cada jogo é um documento: mecânicas, expansões e faixa de jogadores cabem num registro só.</p>
        </div>
      </div>
      <div class="banco banco-grafo">
        <span class="banco-icone" aria-hidden="true">🕸️</span>
        <div>
          <strong>Neo4j</strong>
          <p>Liga jogos às mecânicas e designers. "Jogos parecidos" vira um passeio curto pelo grafo.</p>
        </div>
      </div>
    </section>

    <section class="secao">
      <div class="secao-cabecalho">
        <h2>Navegue por categoria</h2>
      </div>
      <div class="grade-categorias">
        ${CATEGORIAS.map((cat) => `
          <a class="tile-categoria" href="${escaparHtml(montarHashCatalogo({ categoria: cat.nome }))}" style="--capa-de:${cat.de};--capa-para:${cat.para}">
            <span class="tile-emoji" aria-hidden="true">${cat.emoji}</span>
            <span class="tile-nome">${escaparHtml(cat.nome)}</span>
          </a>`).join('')}
      </div>
    </section>

    <section class="secao">
      <div class="secao-cabecalho">
        <h2>🏆 Jogos mais vistos</h2>
        <p>Ranking contado no PostgreSQL, nomes buscados no MongoDB numa chamada só.</p>
      </div>
      <div id="ranking">${carregandoHtml('Contando as visualizações…')}</div>
    </section>`;

  const alvo = app.querySelector('#ranking');
  try {
    const ranking = await api.ranking(10);
    if (!vigente()) return;
    const itens = await juntarComAcervo(ranking);
    if (!vigente()) return;

    alvo.innerHTML = itens.length
      ? `<ol class="ranking">${itens.map(rankingItemHtml).join('')}</ol>`
      : vazioHtml({
          icone: '👀',
          titulo: 'Ninguém abriu um jogo ainda',
          texto: 'O ranking aparece assim que alguém visitar a página de um jogo. Que tal ser o primeiro?',
          acaoHtml: '<a class="botao botao-primario" href="#/jogos">Explorar o catálogo</a>'
        });
  } catch (erro) {
    if (!vigente()) return;
    alvo.innerHTML = erroHtml('Não deu para carregar o ranking', erro);
  }
}

function rankingItemHtml(item, indice) {
  const posicao = indice + 1;
  const medalha = ['ouro', 'prata', 'bronze'][indice] || '';
  const total = Number(item.visualizacoes) || 0;
  const { jogo } = item;
  return `
    <li>
      <a class="ranking-item${medalha ? ` ranking-${medalha}` : ''}" href="${escaparHtml(hrefJogo(jogo._id))}">
        <span class="medalha ${medalha}" aria-label="${posicao}º lugar">${posicao}º</span>
        ${capaHtml(jogo, 'mini')}
        <span class="ranking-info">
          <strong class="ranking-nome">${escaparHtml(jogo.nome)}</strong>
          ${chipCategoriaHtml(jogo.categoria)}
        </span>
        <span class="ranking-views">👁 ${plural(total, 'visualização', 'visualizações')}</span>
      </a>
    </li>`;
}

// ---- 9.2 Catálogo ----------------------------------------------------------

function lerFiltrosCatalogo(query) {
  const jogadores = Number.parseInt(query.get('jogadores') || '', 10);
  return {
    q: (query.get('q') || '').trim(),
    categoria: (query.get('categoria') || '').trim(),
    // o select só oferece 1..8; qualquer outra coisa na URL é ignorada
    jogadores: jogadores >= 1 && jogadores <= 8 ? String(jogadores) : ''
  };
}

async function telaCatalogo({ app, query, vigente }) {
  const filtros = lerFiltrosCatalogo(query);
  definirTitulo(filtros.categoria ? `Jogos de ${filtros.categoria}` : 'Jogos');

  const opcoesJogadores = ['<option value="">Qualquer</option>']
    .concat([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `
      <option value="${n}"${String(n) === filtros.jogadores ? ' selected' : ''}>${n} ${n === 1 ? 'jogador' : 'jogadores'}</option>`))
    .join('');

  const chips = [{ nome: '', emoji: '✨', rotulo: 'Todas' }]
    .concat(CATEGORIAS.map((cat) => ({ nome: cat.nome, emoji: cat.emoji, rotulo: cat.nome })))
    .map((cat) => {
      const ativo = cat.nome === filtros.categoria;
      const href = montarHashCatalogo({ ...filtros, categoria: cat.nome });
      return `<a class="chip${ativo ? ' ativo' : ''}" href="${escaparHtml(href)}"${ativo ? ' aria-current="true"' : ''}>${cat.emoji} ${escaparHtml(cat.rotulo)}</a>`;
    })
    .join('');

  app.innerHTML = `
    <div class="titulo-pagina">
      <div>
        <h1>Catálogo de jogos</h1>
        <p id="resumo-busca" class="resumo-busca">Procurando no acervo…</p>
      </div>
      ${estaLogado() ? '<a class="botao botao-primario" href="#/jogos/novo">+ Novo jogo</a>' : ''}
    </div>

    <form class="barra-filtros" data-form="busca" role="search">
      <div class="campo busca-campo">
        <label class="visualmente-oculto" for="busca-q">Buscar jogos</label>
        <span class="busca-lupa" aria-hidden="true">🔍</span>
        <input id="busca-q" class="entrada" type="search" name="q" value="${escaparHtml(filtros.q)}"
               placeholder="Buscar por nome, mecânica, designer ou tag…" autocomplete="off" maxlength="100">
      </div>
      <label class="filtro-jogadores">
        <span>Nº de jogadores</span>
        <select class="entrada" name="jogadores" data-filtro="jogadores">${opcoesJogadores}</select>
      </label>
      <input type="hidden" name="categoria" value="${escaparHtml(filtros.categoria)}">
      <button class="botao botao-secundario" type="submit">Buscar</button>
    </form>

    <nav class="chips-categorias" aria-label="Filtrar por categoria">${chips}</nav>

    <div id="resultado">${carregandoHtml('Abrindo as caixas…')}</div>`;

  const alvo = app.querySelector('#resultado');
  const resumo = app.querySelector('#resumo-busca');
  const temFiltro = Boolean(filtros.q || filtros.categoria || filtros.jogadores);

  try {
    // limite 100 = teto da API; o acervo de demonstração cabe inteiro numa página
    const jogos = comoLista(await api.listarJogos({ ...filtros, limite: 100 }));
    if (!vigente()) return;

    const detalhes = [];
    if (filtros.q) detalhes.push(`para “${filtros.q}”`);
    if (filtros.categoria) detalhes.push(`em ${filtros.categoria}`);
    if (filtros.jogadores) detalhes.push(`que aceitam ${plural(Number(filtros.jogadores), 'jogador', 'jogadores')}`);
    resumo.innerHTML = `
      <span>${escaparHtml(`${plural(jogos.length, 'jogo encontrado', 'jogos encontrados')} ${detalhes.join(' ')}`.trim())}</span>
      ${temFiltro ? '<a href="#/jogos">✕ limpar filtros</a>' : ''}`;

    alvo.innerHTML = jogos.length
      ? `<div class="grade-jogos">${jogos.map((jogo) => cartaoJogoHtml(jogo)).join('')}</div>`
      : vazioHtml({
          icone: '🔍',
          titulo: temFiltro ? 'Nenhum jogo bate com esses filtros' : 'O acervo está vazio',
          texto: temFiltro
            ? 'Tente outra palavra, outra categoria ou um número de jogadores diferente.'
            : 'Rode o seed do servico-acervo ou cadastre o primeiro jogo.',
          acaoHtml: temFiltro
            ? '<a class="botao botao-contorno" href="#/jogos">Limpar filtros</a>'
            : (estaLogado() ? '<a class="botao botao-primario" href="#/jogos/novo">+ Cadastrar jogo</a>' : '')
        });
  } catch (erro) {
    if (!vigente()) return;
    resumo.textContent = 'Não foi possível consultar o acervo.';
    alvo.innerHTML = erroHtml('Não deu para carregar os jogos', erro);
  }
}

function aplicarBusca(form) {
  const dados = new FormData(form);
  irPara(montarHashCatalogo({
    q: String(dados.get('q') || '').trim(),
    categoria: String(dados.get('categoria') || ''),
    jogadores: String(dados.get('jogadores') || '')
  }));
}

// ---- 9.3 Detalhe -----------------------------------------------------------

async function telaDetalhe({ app, partes, vigente }) {
  const [idDaRota] = partes;
  definirTitulo('Carregando jogo…');
  app.innerHTML = carregandoHtml('Buscando o jogo no acervo…');

  let jogo;
  let favoritos = [];
  try {
    // jogo (Mongo) e favoritos (Postgres) em paralelo: a tela espera só o mais lento
    [jogo, favoritos] = await Promise.all([
      api.buscarJogo(idDaRota),
      estaLogado() ? api.favoritos(false).catch(() => []) : Promise.resolve([])
    ]);
  } catch (erro) {
    if (!vigente()) return;
    if (erro.status === 404) {
      definirTitulo('Jogo não encontrado');
      app.innerHTML = vazioHtml({
        icone: '🧩',
        titulo: 'Jogo não encontrado',
        texto: 'Ele pode ter sido removido do acervo, ou o link está quebrado.',
        acaoHtml: '<a class="botao botao-primario" href="#/jogos">Voltar ao catálogo</a>'
      });
      return;
    }
    definirTitulo('Erro');
    app.innerHTML = erroHtml('Não deu para abrir esse jogo', erro);
    return;
  }
  if (!vigente()) return;
  if (!jogo || !jogo._id) {
    app.innerHTML = erroHtml('Não deu para abrir esse jogo', new Error('O acervo respondeu sem os dados do jogo.'));
    return;
  }

  const jogoId = String(jogo._id);

  // registra a visualização sem await: quem está olhando não precisa esperar o
  // INSERT no Postgres pra ver a página. Se falhar, só fica no console.
  api.registrarVisualizacao(jogoId).catch((erro) => console.warn('Visualização não registrada:', erro.message));

  const favoritado = comoLista(favoritos).some((f) => String(f.jogoId).toLowerCase() === jogoId.toLowerCase());
  definirTitulo(jogo.nome || 'Jogo');
  app.innerHTML = detalheHtml(jogo, favoritado);

  // o grafo carrega em segundo plano; a página já está utilizável
  carregarParecidos(jogoId, vigente);
}

function linkBusca(texto) {
  return escaparHtml(montarHashCatalogo({ q: texto }));
}

function detalheHtml(jogo, favoritado) {
  const id = String(jogo._id);
  const designers = comoLista(jogo.designers);
  const mecanicas = comoLista(jogo.mecanicas);
  const tags = comoLista(jogo.tags);
  const expansoes = comoLista(jogo.expansoes).filter((exp) => exp && exp.nome);
  const ano = numeroOuNulo(jogo.ano);
  const duracao = numeroOuNulo(jogo.duracaoMinutos);
  const idade = numeroOuNulo(jogo.idadeMinima);
  const faixa = faixaJogadores(jogo);

  const subtitulo = [
    ano ? `📅 ${ano}` : '',
    jogo.editora ? `🏢 ${jogo.editora}` : ''
  ].filter(Boolean);

  const acoes = estaLogado()
    ? `
      <div class="acoes-detalhe">
        <button type="button" class="botao botao-favorito${favoritado ? ' ativo' : ''}" data-acao="favoritar"
                data-id="${escaparHtml(id)}" aria-pressed="${favoritado ? 'true' : 'false'}">${favoritado ? '♥ Favorito' : '♡ Favoritar'}</button>
        <a class="botao botao-contorno" href="${escaparHtml(`${hrefJogo(id)}/editar`)}">✏️ Editar</a>
        <button type="button" class="botao botao-perigo" data-acao="excluir-jogo"
                data-id="${escaparHtml(id)}" data-nome="${escaparHtml(jogo.nome)}">🗑️ Excluir</button>
      </div>`
    : `<p class="dica-login"><a href="#/entrar">Entre</a> ou <a href="#/cadastro">crie uma conta</a> para favoritar e editar jogos.</p>`;

  const blocos = [];
  if (jogo.descricao) {
    blocos.push(`
      <section class="bloco bloco-largo">
        <h2>📖 Sobre o jogo</h2>
        <p class="texto-longo">${escaparHtml(jogo.descricao)}</p>
      </section>`);
  }
  if (mecanicas.length) {
    blocos.push(`
      <section class="bloco">
        <h2>⚙️ Mecânicas</h2>
        <div class="lista-chips">
          ${mecanicas.map((m) => `<a class="chip" href="${linkBusca(m)}">${escaparHtml(m)}</a>`).join('')}
        </div>
      </section>`);
  }
  if (tags.length) {
    blocos.push(`
      <section class="bloco">
        <h2>🏷️ Tags</h2>
        <div class="lista-chips">
          ${tags.map((t) => `<a class="chip" href="${linkBusca(t)}">#${escaparHtml(t)}</a>`).join('')}
        </div>
      </section>`);
  }
  if (expansoes.length) {
    blocos.push(`
      <section class="bloco${mecanicas.length && tags.length ? ' bloco-largo' : ''}">
        <h2>📦 Expansões</h2>
        <ul class="lista-expansoes">
          ${expansoes.map((exp) => `
            <li><span aria-hidden="true">➕</span> ${escaparHtml(exp.nome)}${numeroOuNulo(exp.ano) ? ` <small>(${escaparHtml(exp.ano)})</small>` : ''}</li>`).join('')}
        </ul>
      </section>`);
  }
  if (jogo.comoJogar) {
    blocos.push(`
      <section class="bloco bloco-largo bloco-regras">
        <h2>🎯 Como jogar</h2>
        <p class="texto-longo">${escaparHtml(jogo.comoJogar)}</p>
      </section>`);
  }

  return `
    <a class="voltar" href="#/jogos">← Voltar ao catálogo</a>

    <article class="detalhe">
      <div class="detalhe-capa">${capaHtml(jogo, 'grande')}</div>

      <div class="detalhe-info">
        ${chipCategoriaHtml(jogo.categoria)}
        <h1 class="detalhe-nome">${escaparHtml(jogo.nome)}</h1>
        ${subtitulo.length ? `<p class="detalhe-sub">${subtitulo.map((s) => `<span>${escaparHtml(s)}</span>`).join('')}</p>` : ''}
        ${designers.length
          ? `<p class="detalhe-designers">✍️ Design de ${designers.map((d) => `<a href="${linkBusca(d)}">${escaparHtml(d)}</a>`).join(', ')}</p>`
          : ''}

        <dl class="ficha">
          <div class="ficha-item"><dt>👥 Jogadores</dt><dd>${escaparHtml(faixa || '—')}</dd></div>
          <div class="ficha-item"><dt>⏱ Duração</dt><dd>${duracao ? `${escaparHtml(duracao)} min` : '—'}</dd></div>
          <div class="ficha-item"><dt>🎂 Idade mínima</dt><dd>${idade !== null ? `${escaparHtml(idade)}+` : '—'}</dd></div>
          <div class="ficha-item"><dt>🧠 Complexidade</dt><dd>${barraComplexidadeHtml(jogo.complexidade)}</dd></div>
        </dl>

        ${acoes}
      </div>
    </article>

    ${blocos.length ? `<div class="detalhe-blocos">${blocos.join('')}</div>` : ''}

    <section class="secao" id="parecidos" aria-live="polite">
      <div class="secao-cabecalho">
        <h2>🔗 Jogos parecidos (via grafo no Neo4j)</h2>
        <p>Pontuação = mecânicas em comum + 2 × designers em comum.</p>
      </div>
      <div id="lista-parecidos">${carregandoHtml('Percorrendo o grafo…')}</div>
    </section>`;
}

function motivoParecido(item) {
  const designers = comoLista(item.designersEmComum);
  const mecanicas = comoLista(item.mecanicasEmComum).map(capitalizar);
  const motivos = [];
  if (designers.length) {
    motivos.push(`${designers.length === 1 ? 'mesmo designer' : 'mesmos designers'}: ${designers.join(', ')}`);
  }
  if (mecanicas.length) {
    motivos.push(`${mecanicas.length} ${mecanicas.length === 1 ? 'mecânica' : 'mecânicas'} em comum: ${mecanicas.join(', ')}`);
  }
  return motivos.join(' · ');
}

function parecidoHtml(item) {
  const pontuacao = Number(item.pontuacao) || 0;
  return `
    <a class="cartao-parecido" href="${escaparHtml(hrefJogo(item.jogoId))}">
      ${capaHtml({ nome: item.nome, categoria: item.categoria }, 'mini')}
      <span class="parecido-info">
        <strong>${escaparHtml(item.nome)}</strong>
        ${chipCategoriaHtml(item.categoria)}
        <span class="parecido-motivo">${escaparHtml(motivoParecido(item))}</span>
      </span>
      <span class="afinidade" title="Pontuação de afinidade no grafo">${escaparHtml(plural(pontuacao, 'pt', 'pts'))}</span>
    </a>`;
}

async function carregarParecidos(jogoId, vigente) {
  const secao = document.getElementById('parecidos');
  if (!secao) return;
  try {
    const lista = comoLista(await api.similares(jogoId));
    if (!vigente() || !secao.isConnected) return;
    if (!lista.length) {
      secao.remove(); // sem vizinhos no grafo: a seção some em vez de mostrar caixa vazia
      return;
    }
    secao.querySelector('#lista-parecidos').innerHTML =
      `<div class="grade-parecidos">${lista.map(parecidoHtml).join('')}</div>`;
  } catch (erro) {
    // o grafo é um "extra": se o Neo4j estiver fora, a página do jogo continua de pé
    console.warn('Jogos parecidos indisponíveis:', erro.message);
    if (secao.isConnected) secao.remove();
  }
}

function pintarBotaoFavorito(botao, favoritado) {
  botao.classList.toggle('ativo', favoritado);
  botao.setAttribute('aria-pressed', favoritado ? 'true' : 'false');
  botao.textContent = favoritado ? '♥ Favorito' : '♡ Favoritar';
}

async function alternarFavorito(botao) {
  const id = botao.dataset.id;
  if (!id) return;
  const estavaFavoritado = botao.getAttribute('aria-pressed') === 'true';
  botao.disabled = true;
  try {
    if (estavaFavoritado) await api.desfavoritar(id);
    else await api.favoritar(id);
    pintarBotaoFavorito(botao, !estavaFavoritado);
    mostrarAviso(estavaFavoritado ? 'Removido dos favoritos.' : 'Guardado nos favoritos! ♥', 'sucesso');
  } catch (erro) {
    if (!erro.sessaoExpirada) mostrarAviso(erro.message, 'erro');
  } finally {
    botao.disabled = false;
  }
}

async function excluirJogo(botao) {
  const id = botao.dataset.id;
  if (!id) return;
  const nome = botao.dataset.nome || 'este jogo';
  const confirmou = window.confirm(
    `Excluir "${nome}" do acervo?\n\nEle sai do catálogo (MongoDB) e do grafo de afinidades (Neo4j). Não dá para desfazer.`
  );
  if (!confirmou) return;

  botao.disabled = true;
  try {
    await api.excluirJogo(id);
    mostrarAviso('Jogo removido do acervo.', 'sucesso');
    irPara('#/jogos');
  } catch (erro) {
    mostrarAviso(erro.message, 'erro');
    botao.disabled = false;
  }
}

// ---- 9.4 Formulário de jogo (novo / editar) --------------------------------

function linhaExpansaoHtml(expansao = {}) {
  return `
    <div class="linha-expansao">
      <input class="entrada" name="expansao-nome" placeholder="Nome da expansão" maxlength="120"
             value="${escaparHtml(expansao.nome)}" aria-label="Nome da expansão">
      <input class="entrada" name="expansao-ano" type="number" min="1800" max="2100" step="1" placeholder="Ano"
             value="${escaparHtml(numeroOuNulo(expansao.ano) ?? '')}" aria-label="Ano da expansão">
      <button type="button" class="botao botao-contorno botao-pequeno" data-acao="remover-expansao"
              aria-label="Remover expansão" title="Remover expansão">✕</button>
    </div>`;
}

function formularioJogoHtml(jogo, idEdicao) {
  const editando = Boolean(idEdicao);
  const id = editando ? String(jogo._id || idEdicao) : '';
  const valor = (campo) => escaparHtml(campo ?? '');
  const lista = (campo) => escaparHtml(comoLista(campo).join(', '));
  const faixa = jogo.jogadores || {};
  const categoriaAtual = jogo.categoria || CATEGORIA_PADRAO.nome;
  const opcoesCategoria = CATEGORIAS.map((cat) =>
    `<option value="${escaparHtml(cat.nome)}"${cat.nome === categoriaAtual ? ' selected' : ''}>${cat.emoji} ${escaparHtml(cat.nome)}</option>`
  ).join('');
  const destinoCancelar = editando ? hrefJogo(id) : '#/jogos';

  return `
    <a class="voltar" href="${escaparHtml(destinoCancelar)}">← ${editando ? 'Voltar ao jogo' : 'Voltar ao catálogo'}</a>

    <div class="titulo-pagina">
      <div>
        <h1>${editando ? `✏️ Editar ${escaparHtml(jogo.nome)}` : '🧩 Novo jogo'}</h1>
        <p>Os dados vão pro MongoDB; mecânicas e designers também atualizam o grafo do Neo4j sozinhos.</p>
      </div>
    </div>

    <form class="formulario" data-form="jogo" data-id="${escaparHtml(id)}">
      <div class="erro-formulario" id="erro-jogo" role="alert" hidden></div>

      <fieldset class="grupo-campos">
        <legend>Identificação</legend>
        <div class="linha-campos colunas-3">
          <div class="campo campo-largo">
            <label for="campo-nome">Nome <span class="obrigatorio">*</span></label>
            <input id="campo-nome" class="entrada" name="nome" required maxlength="120" value="${valor(jogo.nome)}" placeholder="Ex.: Catan">
          </div>
          <div class="campo">
            <label for="campo-categoria">Categoria</label>
            <select id="campo-categoria" class="entrada" name="categoria">${opcoesCategoria}</select>
          </div>
        </div>
        <div class="linha-campos colunas-3">
          <div class="campo">
            <label for="campo-ano">Ano de lançamento</label>
            <input id="campo-ano" class="entrada" name="ano" type="number" min="1800" max="2100" step="1" value="${valor(jogo.ano)}">
          </div>
          <div class="campo">
            <label for="campo-editora">Editora</label>
            <input id="campo-editora" class="entrada" name="editora" maxlength="120" value="${valor(jogo.editora)}">
          </div>
          <div class="campo">
            <label for="campo-designers">Designers</label>
            <input id="campo-designers" class="entrada" name="designers" value="${lista(jogo.designers)}" placeholder="separados por vírgula">
          </div>
        </div>
      </fieldset>

      <fieldset class="grupo-campos">
        <legend>Ficha da partida</legend>
        <div class="linha-campos colunas-5">
          <div class="campo">
            <label for="campo-min">Jogadores (mín.)</label>
            <input id="campo-min" class="entrada" name="jogadoresMin" type="number" min="1" max="100" step="1" value="${valor(faixa.min)}">
          </div>
          <div class="campo">
            <label for="campo-max">Jogadores (máx.)</label>
            <input id="campo-max" class="entrada" name="jogadoresMax" type="number" min="1" max="100" step="1" value="${valor(faixa.max)}">
          </div>
          <div class="campo">
            <label for="campo-duracao">Duração (min)</label>
            <input id="campo-duracao" class="entrada" name="duracaoMinutos" type="number" min="1" step="1" value="${valor(jogo.duracaoMinutos)}">
          </div>
          <div class="campo">
            <label for="campo-idade">Idade mínima</label>
            <input id="campo-idade" class="entrada" name="idadeMinima" type="number" min="0" max="99" step="1" value="${valor(jogo.idadeMinima)}">
          </div>
          <div class="campo">
            <label for="campo-complexidade">Complexidade (1–5)</label>
            <input id="campo-complexidade" class="entrada" name="complexidade" type="number" min="1" max="5" step="0.1" value="${valor(jogo.complexidade)}">
          </div>
        </div>
      </fieldset>

      <fieldset class="grupo-campos">
        <legend>Sobre o jogo</legend>
        <div class="campo">
          <label for="campo-imagem">URL da imagem</label>
          <input id="campo-imagem" class="entrada" name="imagem" type="url" value="${valor(jogo.imagem)}" placeholder="https://…">
          <span class="dica">Opcional. Sem imagem, a Ludoteca gera uma capa com a cor da categoria.</span>
        </div>
        <div class="campo">
          <label for="campo-descricao">Descrição</label>
          <textarea id="campo-descricao" class="entrada" name="descricao" rows="3">${valor(jogo.descricao)}</textarea>
        </div>
        <div class="campo">
          <label for="campo-mecanicas">Mecânicas</label>
          <input id="campo-mecanicas" class="entrada" name="mecanicas" value="${lista(jogo.mecanicas)}" placeholder="Ex.: Draft, Colocação de peças">
          <span class="dica">Separadas por vírgula. São elas que ligam este jogo a outros no grafo.</span>
        </div>
      </fieldset>

      <fieldset class="grupo-campos">
        <legend>Expansões</legend>
        <div class="lista-expansoes-form" id="lista-expansoes">${comoLista(jogo.expansoes).map((exp) => linhaExpansaoHtml(exp)).join('')}</div>
        <button type="button" class="botao botao-contorno botao-pequeno botao-adicionar" data-acao="adicionar-expansao">+ Adicionar expansão</button>
      </fieldset>

      <fieldset class="grupo-campos">
        <legend>Regras e etiquetas</legend>
        <div class="campo">
          <label for="campo-como-jogar">Como jogar</label>
          <textarea id="campo-como-jogar" class="entrada" name="comoJogar" rows="4">${valor(jogo.comoJogar)}</textarea>
        </div>
        <div class="campo">
          <label for="campo-tags">Tags</label>
          <input id="campo-tags" class="entrada" name="tags" value="${lista(jogo.tags)}" placeholder="Ex.: rápido, festa, dois jogadores">
        </div>
      </fieldset>

      <div class="acoes-formulario">
        <a class="botao botao-contorno" href="${escaparHtml(destinoCancelar)}">Cancelar</a>
        <button type="submit" class="botao botao-primario">${editando ? '💾 Salvar alterações' : '💾 Cadastrar jogo'}</button>
      </div>
    </form>`;
}

async function telaFormularioJogo({ app, partes, vigente }) {
  const [idDaRota] = partes;
  const editando = Boolean(idDaRota);
  let jogo = {};

  if (editando) {
    definirTitulo('Editar jogo');
    app.innerHTML = carregandoHtml('Carregando os dados do jogo…');
    try {
      jogo = (await api.buscarJogo(idDaRota)) || {};
    } catch (erro) {
      if (!vigente()) return;
      app.innerHTML = erro.status === 404
        ? vazioHtml({
            icone: '🧩',
            titulo: 'Jogo não encontrado',
            texto: 'Não dá pra editar um jogo que não está no acervo.',
            acaoHtml: '<a class="botao botao-primario" href="#/jogos">Voltar ao catálogo</a>'
          })
        : erroHtml('Não deu para carregar o jogo', erro);
      return;
    }
    if (!vigente()) return;
  }

  definirTitulo(editando ? `Editar ${jogo.nome || 'jogo'}` : 'Novo jogo');
  app.innerHTML = formularioJogoHtml(jogo, editando ? idDaRota : '');
  const campoNome = app.querySelector('#campo-nome');
  if (campoNome) campoNome.focus();
}

function adicionarLinhaExpansao() {
  const lista = document.getElementById('lista-expansoes');
  if (!lista) return;
  lista.insertAdjacentHTML('beforeend', linhaExpansaoHtml());
  const nova = lista.lastElementChild && lista.lastElementChild.querySelector('input');
  if (nova) nova.focus();
}

/** "a, b, , a" → ["a", "b"] (tira vazios e repetidos sem ligar pra maiúscula) */
function listaPorVirgula(texto) {
  const vistos = new Set();
  return String(texto || '')
    .split(',')
    .map((parte) => parte.trim())
    .filter((parte) => {
      const chave = parte.toLocaleLowerCase('pt-BR');
      if (!parte || vistos.has(chave)) return false;
      vistos.add(chave);
      return true;
    });
}

/** Número de um campo; vazio vira undefined (= não envia). */
function lerNumero(texto, rotulo, { min, max } = {}) {
  const limpo = String(texto || '').trim().replace(',', '.');
  if (!limpo) return undefined;
  const n = Number(limpo);
  if (!Number.isFinite(n)) throw new Error(`${rotulo}: informe um número válido.`);
  if (min !== undefined && n < min) throw new Error(`${rotulo}: o mínimo é ${min}.`);
  if (max !== undefined && n > max) throw new Error(`${rotulo}: o máximo é ${max}.`);
  return n;
}

/**
 * Monta o corpo do POST/PUT a partir do form. Regras do contrato:
 * números vazios NÃO são enviados; nome obrigatório; máx ≥ mín.
 * Textos vazios só são enviados na edição (pra dar pra apagar uma descrição, por exemplo).
 */
function montarJogoDoFormulario(form, editando) {
  const campo = (nome) => {
    const elemento = form.elements.namedItem(nome);
    return elemento && 'value' in elemento ? String(elemento.value).trim() : '';
  };

  const nome = campo('nome');
  if (!nome) throw new Error('O nome do jogo é obrigatório.');

  const dados = { nome, categoria: campo('categoria') || CATEGORIA_PADRAO.nome };

  const numeros = [
    ['ano', 'Ano', { min: 1800, max: 2100 }],
    ['duracaoMinutos', 'Duração', { min: 1 }],
    ['idadeMinima', 'Idade mínima', { min: 0, max: 99 }],
    ['complexidade', 'Complexidade', { min: 1, max: 5 }]
  ];
  numeros.forEach(([chave, rotulo, limites]) => {
    const n = lerNumero(campo(chave), rotulo, limites);
    if (n !== undefined) dados[chave] = n;
  });

  const min = lerNumero(campo('jogadoresMin'), 'Jogadores (mín.)', { min: 1, max: 100 });
  const max = lerNumero(campo('jogadoresMax'), 'Jogadores (máx.)', { min: 1, max: 100 });
  if (min !== undefined && max !== undefined && max < min) {
    throw new Error('O número máximo de jogadores não pode ser menor que o mínimo.');
  }
  if (min !== undefined || max !== undefined) {
    dados.jogadores = {};
    if (min !== undefined) dados.jogadores.min = min;
    if (max !== undefined) dados.jogadores.max = max;
  }

  ['editora', 'imagem', 'descricao', 'comoJogar'].forEach((chave) => {
    const texto = campo(chave);
    if (texto || editando) dados[chave] = texto;
  });

  // listas sempre vão (mesmo vazias): assim apagar todas as mecânicas na edição funciona
  dados.designers = listaPorVirgula(campo('designers'));
  dados.mecanicas = listaPorVirgula(campo('mecanicas'));
  dados.tags = listaPorVirgula(campo('tags'));

  dados.expansoes = [];
  form.querySelectorAll('.linha-expansao').forEach((linha, indice) => {
    const nomeExp = String(linha.querySelector('[name="expansao-nome"]').value || '').trim();
    const anoTexto = linha.querySelector('[name="expansao-ano"]').value;
    if (!nomeExp && !String(anoTexto || '').trim()) return; // linha em branco: ignora
    if (!nomeExp) throw new Error(`A expansão nº ${indice + 1} está sem nome.`);
    const expansao = { nome: nomeExp };
    const anoExp = lerNumero(anoTexto, `Ano da expansão "${nomeExp}"`, { min: 1800, max: 2100 });
    if (anoExp !== undefined) expansao.ano = anoExp;
    dados.expansoes.push(expansao);
  });

  return dados;
}

function mostrarErroFormulario(caixa, mensagem) {
  if (!caixa) {
    mostrarAviso(mensagem, 'erro');
    return;
  }
  caixa.textContent = mensagem;
  caixa.hidden = false;
  caixa.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function salvarJogo(form) {
  const caixaErro = form.querySelector('#erro-jogo');
  const botao = form.querySelector('button[type="submit"]');
  const id = form.dataset.id || '';
  const editando = Boolean(id);

  let dados;
  try {
    dados = montarJogoDoFormulario(form, editando);
  } catch (erroValidacao) {
    mostrarErroFormulario(caixaErro, erroValidacao.message);
    return;
  }
  if (caixaErro) caixaErro.hidden = true;

  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Salvando…';
  try {
    const salvo = editando ? await api.atualizarJogo(id, dados) : await api.criarJogo(dados);
    mostrarAviso(editando ? 'Alterações salvas!' : 'Jogo cadastrado no acervo!', 'sucesso');
    const destino = (salvo && salvo._id) || id;
    irPara(destino ? hrefJogo(destino) : '#/jogos');
  } catch (erro) {
    mostrarErroFormulario(caixaErro, erro.message);
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

// ---- 9.5 Favoritos e Histórico ---------------------------------------------
// As duas telas seguem o mesmo roteiro: lista de ids no Postgres → UM GET em
// lote no Mongo → grid na ordem que o Postgres devolveu.

async function telaListaPessoal({ app, vigente, titulo, subtitulo, textoCarregando, buscar, rodape, vazio }) {
  app.innerHTML = `
    <div class="titulo-pagina">
      <div>
        <h1>${titulo}</h1>
        <p>${subtitulo}</p>
      </div>
      <a class="botao botao-contorno" href="#/jogos">Ver catálogo</a>
    </div>
    <div id="lista-pessoal">${carregandoHtml(textoCarregando)}</div>`;

  const alvo = app.querySelector('#lista-pessoal');
  try {
    const registros = comoLista(await buscar());
    if (!vigente()) return;
    const itens = await juntarComAcervo(registros);
    if (!vigente()) return;

    if (!itens.length) {
      alvo.innerHTML = vazioHtml(vazio);
      return;
    }
    const sumidos = registros.length - itens.length;
    alvo.innerHTML = `
      <div class="grade-jogos">${itens.map((item) => cartaoJogoHtml(item.jogo, rodape(item))).join('')}</div>
      ${sumidos > 0 ? `<p class="nota-rodape">${escaparHtml(plural(sumidos, 'jogo da lista não existe', 'jogos da lista não existem'))} mais no acervo.</p>` : ''}`;
  } catch (erro) {
    if (!vigente() || erro.sessaoExpirada) return;
    alvo.innerHTML = erroHtml('Não deu para carregar a lista', erro);
  }
}

function telaFavoritos({ app, vigente }) {
  definirTitulo('Favoritos');
  return telaListaPessoal({
    app,
    vigente,
    titulo: '♥ Meus favoritos',
    subtitulo: 'Guardados no PostgreSQL; os detalhes de cada jogo vêm do MongoDB.',
    textoCarregando: 'Separando os seus preferidos…',
    buscar: () => api.favoritos(),
    rodape: (item) => {
      const data = formatarData(item.adicionadoEm);
      return data ? `<p class="cartao-rodape">♥ favoritado em ${escaparHtml(data)}</p>` : '';
    },
    vazio: {
      icone: '💔',
      titulo: 'Você ainda não favoritou nenhum jogo',
      texto: 'Abra um jogo do catálogo e toque em “♡ Favoritar” para guardar ele aqui.',
      acaoHtml: '<a class="botao botao-primario" href="#/jogos">Explorar o catálogo</a>'
    }
  });
}

function telaHistorico({ app, vigente }) {
  definirTitulo('Histórico');
  return telaListaPessoal({
    app,
    vigente,
    titulo: '🕒 Vistos recentemente',
    subtitulo: 'Os últimos 20 jogos diferentes que você abriu, do mais recente pro mais antigo.',
    textoCarregando: 'Relembrando suas últimas partidas…',
    buscar: () => api.historico(),
    rodape: (item) => {
      const quando = formatarDataHora(item.ultimaVez);
      return quando ? `<p class="cartao-rodape">🕒 visto em ${escaparHtml(quando)}</p>` : '';
    },
    vazio: {
      icone: '🕰️',
      titulo: 'Seu histórico está vazio',
      texto: 'Cada jogo que você abrir logado aparece aqui.',
      acaoHtml: '<a class="botao botao-primario" href="#/jogos">Começar a explorar</a>'
    }
  });
}

// ---- 9.6 Entrar / Criar conta ----------------------------------------------

function telaEntrar({ app }) {
  definirTitulo('Entrar');
  app.innerHTML = `
    <div class="cartao-auth">
      <div class="auth-icone" aria-hidden="true">🎲</div>
      <h1>Entrar na Ludoteca</h1>
      <p class="auth-sub">Com a conta você favorita jogos e acompanha seu histórico.</p>
      <form class="formulario-auth" data-form="entrar">
        <div class="erro-formulario" id="erro-auth" role="alert" hidden></div>
        <div class="campo">
          <label for="entrar-email">E-mail</label>
          <input id="entrar-email" class="entrada" type="email" name="email" required autocomplete="email" placeholder="voce@exemplo.com">
        </div>
        <div class="campo">
          <label for="entrar-senha">Senha</label>
          <input id="entrar-senha" class="entrada" type="password" name="senha" required minlength="6" autocomplete="current-password">
        </div>
        <button type="submit" class="botao botao-primario botao-bloco botao-grande">Entrar</button>
      </form>
      <p class="auth-troca">Ainda não tem conta? <a href="#/cadastro">Criar conta</a></p>
    </div>`;
  const email = app.querySelector('#entrar-email');
  if (email) email.focus();
}

function telaCadastro({ app }) {
  definirTitulo('Criar conta');
  app.innerHTML = `
    <div class="cartao-auth">
      <div class="auth-icone" aria-hidden="true">🧩</div>
      <h1>Criar conta</h1>
      <p class="auth-sub">Leva dez segundos. Sua conta fica guardada no PostgreSQL, com senha criptografada.</p>
      <form class="formulario-auth" data-form="cadastro">
        <div class="erro-formulario" id="erro-auth" role="alert" hidden></div>
        <div class="campo">
          <label for="cadastro-nome">Nome</label>
          <input id="cadastro-nome" class="entrada" name="nome" required maxlength="100" autocomplete="name" placeholder="Como quer ser chamado?">
        </div>
        <div class="campo">
          <label for="cadastro-email">E-mail</label>
          <input id="cadastro-email" class="entrada" type="email" name="email" required maxlength="150" autocomplete="email" placeholder="voce@exemplo.com">
        </div>
        <div class="campo">
          <label for="cadastro-senha">Senha</label>
          <input id="cadastro-senha" class="entrada" type="password" name="senha" required minlength="6" autocomplete="new-password">
          <span class="dica">Mínimo de 6 caracteres.</span>
        </div>
        <button type="submit" class="botao botao-primario botao-bloco botao-grande">Criar minha conta</button>
      </form>
      <p class="auth-troca">Já tem conta? <a href="#/entrar">Entrar</a></p>
    </div>`;
  const nome = app.querySelector('#cadastro-nome');
  if (nome) nome.focus();
}

/** Login e cadastro terminam do mesmo jeito: guarda a sessão e volta pro início. */
async function enviarAutenticacao(form, tipo) {
  const caixaErro = form.querySelector('#erro-auth');
  const botao = form.querySelector('button[type="submit"]');
  const valor = (nome) => {
    const elemento = form.elements.namedItem(nome);
    return elemento ? String(elemento.value) : '';
  };

  const dados = { email: valor('email').trim(), senha: valor('senha') };
  if (tipo === 'cadastro') dados.nome = valor('nome').trim();

  let problema = '';
  if (tipo === 'cadastro' && !dados.nome) problema = 'Conta pra gente o seu nome.';
  else if (!dados.email || !dados.senha) problema = 'Preencha e-mail e senha.';
  else if (dados.senha.length < 6) problema = 'A senha precisa ter pelo menos 6 caracteres.';
  if (problema) {
    mostrarErroFormulario(caixaErro, problema);
    return;
  }
  if (caixaErro) caixaErro.hidden = true;

  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = tipo === 'cadastro' ? 'Criando conta…' : 'Entrando…';
  try {
    const resposta = tipo === 'cadastro' ? await api.cadastrar(dados) : await api.entrar(dados);
    if (!resposta || !resposta.token || !resposta.jogador) throw new Error('Resposta inesperada do servidor.');
    salvarSessao(resposta.jogador, resposta.token);
    mostrarAviso(
      tipo === 'cadastro'
        ? `Conta criada! Bem-vindo, ${primeiroNome(resposta.jogador.nome)}.`
        : `Que bom te ver, ${primeiroNome(resposta.jogador.nome)}!`,
      'sucesso'
    );
    irPara('#/');
  } catch (erro) {
    mostrarErroFormulario(caixaErro, erro.message);
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

function sair() {
  limparSessao();
  mostrarAviso('Você saiu da conta. Até a próxima partida!', 'info');
  irPara('#/');
}

// -----------------------------------------------------------------------------
// 10. Eventos globais (delegação)
// -----------------------------------------------------------------------------
// Um listener por tipo de evento no document em vez de um por botão: o HTML é
// redesenhado o tempo todo, então delegar evita ficar religando (e vazando)
// listeners a cada render — e dispensa onclick inline com id interpolado.

/** Roda uma ação assíncrona garantindo que nenhuma promise fique rejeitada sem tratamento. */
function executar(acao) {
  Promise.resolve()
    .then(acao)
    .catch((erro) => {
      console.error(erro);
      mostrarAviso((erro && erro.message) || 'Algo deu errado.', 'erro');
    });
}

document.addEventListener('click', (evento) => {
  const gatilho = evento.target.closest('[data-acao]');
  if (!gatilho) return;

  switch (gatilho.dataset.acao) {
    case 'sair':
      evento.preventDefault();
      sair();
      break;
    case 'favoritar':
      executar(() => alternarFavorito(gatilho));
      break;
    case 'excluir-jogo':
      executar(() => excluirJogo(gatilho));
      break;
    case 'adicionar-expansao':
      adicionarLinhaExpansao();
      break;
    case 'remover-expansao': {
      const linha = gatilho.closest('.linha-expansao');
      if (linha) linha.remove();
      break;
    }
    case 'recarregar':
      executar(roteador);
      break;
    default:
      break;
  }
});

document.addEventListener('submit', (evento) => {
  const form = evento.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.form) return;
  evento.preventDefault();

  switch (form.dataset.form) {
    case 'busca':
      aplicarBusca(form);
      break;
    case 'jogo':
      executar(() => salvarJogo(form));
      break;
    case 'entrar':
      executar(() => enviarAutenticacao(form, 'entrar'));
      break;
    case 'cadastro':
      executar(() => enviarAutenticacao(form, 'cadastro'));
      break;
    default:
      break;
  }
});

// trocar o nº de jogadores já aplica o filtro, sem precisar clicar em Buscar
document.addEventListener('change', (evento) => {
  const alvo = evento.target;
  if (alvo instanceof HTMLSelectElement && alvo.dataset.filtro === 'jogadores' && alvo.form) {
    aplicarBusca(alvo.form);
  }
});

// Capa com imagem: "error" e "load" não borbulham, então escutamos na fase de
// captura. Imagem quebrada some e deixa a capa gerada à mostra.
document.addEventListener('error', (evento) => {
  const alvo = evento.target;
  if (alvo instanceof HTMLImageElement && alvo.classList.contains('capa-img')) alvo.remove();
}, true);

document.addEventListener('load', (evento) => {
  const alvo = evento.target;
  if (alvo instanceof HTMLImageElement && alvo.classList.contains('capa-img')) alvo.classList.add('carregada');
}, true);

// login/logout feito em outra aba: sincroniza esta aqui também
window.addEventListener('storage', (evento) => {
  if (evento.key === null || evento.key === CHAVE_TOKEN || evento.key === CHAVE_JOGADOR) {
    sessao = lerSessaoSalva();
    executar(roteador);
  }
});

window.addEventListener('hashchange', () => executar(roteador));

// primeira renderização (os <script> estão no fim do <body>, o DOM já existe)
executar(roteador);
