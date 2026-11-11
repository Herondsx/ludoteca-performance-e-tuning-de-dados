// explorador.js — seção "Explorar os dados" do Monitor dos Bancos
//
// A ideia é mostrar o MESMO sistema visto por dentro de cada banco, no formato
// em que cada um guarda a informação:
//   PostgreSQL -> linhas e colunas (tabela de verdade, com NULL e tudo)
//   MongoDB    -> o documento JSON inteiro, do jeito que está gravado
//   Neo4j      -> a vizinhança de um jogo desenhada como grafo (nós e relações)
//
// Diferente dos cartões lá de cima, aqui NÃO tem atualização automática a cada
// 3 s: é pra parar e ler com calma na apresentação, então só recarrega no clique.
// Reaproveita API, buscarJson, escaparHtml e capitalizar, que vêm do monitor.js.

(function () {
  'use strict';

  const jaCarregou = { postgres: false, mongo: false, neo4j: false };
  let documentos = [];           // jogos do acervo (usados nas abas MongoDB e Neo4j)
  let documentoAberto = null;    // _id do documento mostrado na aba MongoDB
  let versaoPostgres = 0;        // evita que uma resposta antiga sobrescreva a nova
  let versaoGrafo = 0;

  // ---------------------------------------------------------------------------
  // JSON COLORIDO
  // ---------------------------------------------------------------------------

  // transforma qualquer valor em JSON indentado com cores por tipo.
  // Primeiro escapa o HTML (então um nome tipo "<script>" vira texto inofensivo),
  // depois só embrulha cada pedaço num <span> com classe fixa.
  function jsonColorido(valor) {
    const texto = JSON.stringify(valor, null, 2);
    if (texto === undefined) return '';
    const seguro = texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return seguro.replace(
      /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (trecho) => {
        let classe = 'json-numero';
        if (trecho.startsWith('"')) classe = /:\s*$/.test(trecho) ? 'json-chave' : 'json-texto';
        else if (trecho === 'true' || trecho === 'false') classe = 'json-booleano';
        else if (trecho === 'null') classe = 'json-nulo';
        return `<span class="${classe}">${trecho}</span>`;
      }
    );
  }

  function mensagem(texto, erro) {
    return `<p class="vazio${erro ? ' erro-explorador' : ''}">${escaparHtml(texto)}</p>`;
  }

  function formatarData(valor) {
    const data = new Date(valor);
    return Number.isNaN(data.getTime()) ? String(valor) : data.toLocaleString('pt-BR');
  }

  // ---------------------------------------------------------------------------
  // ABAS
  // ---------------------------------------------------------------------------

  function abrirAba(nome, focar) {
    document.querySelectorAll('.aba-explorador').forEach((aba) => {
      const ativa = aba.dataset.aba === nome;
      aba.setAttribute('aria-selected', String(ativa));
      aba.tabIndex = ativa ? 0 : -1;
      document.getElementById(aba.getAttribute('aria-controls')).hidden = !ativa;
      if (ativa && focar) aba.focus();
    });
    // cada aba só busca os dados na primeira vez que é aberta
    if (!jaCarregou[nome]) recarregar(nome);
  }

  function recarregar(nome) {
    jaCarregou[nome] = true;
    if (nome === 'postgres') return carregarPostgres();
    if (nome === 'mongo') return carregarMongo();
    if (nome === 'neo4j') return carregarNeo4j();
    return undefined;
  }

  // setas do teclado trocam de aba (padrão de acessibilidade pra "tablist")
  function navegarComTeclado(evento) {
    const abas = [...document.querySelectorAll('.aba-explorador')];
    const atual = abas.indexOf(document.activeElement);
    if (atual === -1) return;
    let proxima = null;
    if (evento.key === 'ArrowRight') proxima = (atual + 1) % abas.length;
    if (evento.key === 'ArrowLeft') proxima = (atual - 1 + abas.length) % abas.length;
    if (evento.key === 'Home') proxima = 0;
    if (evento.key === 'End') proxima = abas.length - 1;
    if (proxima === null) return;
    evento.preventDefault();
    abrirAba(abas[proxima].dataset.aba, true);
  }

  // ---------------------------------------------------------------------------
  // POSTGRESQL: TABELAS
  // ---------------------------------------------------------------------------

  // cada opção do <select> = uma rota da API + o SQL que ela roda por baixo.
  // colunas: [campo no JSON, nome da coluna no banco, formatador opcional]
  const CONSULTAS_POSTGRES = {
    jogadores: {
      rota: () => `${API.jogadores}/jogadores`,
      sql: 'SELECT id, nome, email, criado_em\n  FROM jogadores\n ORDER BY criado_em DESC;',
      colunas: [['id', 'id'], ['nome', 'nome'], ['email', 'email'], ['criadoEm', 'criado_em', formatarData]],
      observacao: 'A coluna senha_hash existe na tabela, mas a API nunca devolve ela.',
    },
    ranking: {
      rota: () => `${API.jogadores}/ranking?limite=50`,
      sql: 'SELECT jogo_id, COUNT(*) AS visualizacoes\n  FROM visualizacoes\n GROUP BY jogo_id\n ORDER BY visualizacoes DESC\n LIMIT 50;',
      colunas: [['jogoId', 'jogo_id'], ['nomeNoAcervo', 'nome (vem do MongoDB)'], ['visualizacoes', 'visualizacoes']],
      observacao: 'O PostgreSQL só guarda o id do jogo; o nome é buscado no MongoDB numa chamada só (?ids=).',
      enriquecer: juntarNomesDosJogos,
    },
    estatisticas: {
      rota: () => `${API.jogadores}/estatisticas`,
      sql: 'SELECT (SELECT COUNT(*) FROM jogadores)     AS jogadores,\n       (SELECT COUNT(*) FROM visualizacoes) AS visualizacoes,\n       (SELECT COUNT(*) FROM favoritos)     AS favoritos;',
      colunas: [['jogadores', 'jogadores'], ['visualizacoes', 'visualizacoes'], ['favoritos', 'favoritos']],
      observacao: 'Três contagens numa única ida ao banco.',
    },
  };

  // ranking só tem jogoId: completa com o nome que está no acervo (MongoDB)
  async function juntarNomesDosJogos(linhas) {
    const ids = linhas.map((linha) => linha.jogoId).filter(Boolean);
    if (!ids.length) return linhas;
    try {
      const jogos = await buscarJson(`${API.acervo}/jogos?ids=${ids.join(',')}`);
      const nomes = new Map((jogos || []).map((jogo) => [String(jogo._id), jogo.nome]));
      return linhas.map((linha) => ({ ...linha, nomeNoAcervo: nomes.get(linha.jogoId) || '(removido do acervo)' }));
    } catch (_) {
      return linhas.map((linha) => ({ ...linha, nomeNoAcervo: '(acervo fora do ar)' }));
    }
  }

  function desenharTabela(linhas, colunas) {
    if (!linhas.length) return mensagem('Nenhuma linha por enquanto. Use as ações de demonstração lá em cima.');
    const cabecalho = colunas.map(([, titulo]) => `<th scope="col">${escaparHtml(titulo)}</th>`).join('');
    const corpo = linhas.map((linha) => {
      const celulas = colunas.map(([campo, , formatar]) => {
        const valor = linha[campo];
        if (valor === null || valor === undefined) return '<td class="celula-nula">NULL</td>';
        return `<td>${escaparHtml(formatar ? formatar(valor) : String(valor))}</td>`;
      }).join('');
      return `<tr>${celulas}</tr>`;
    }).join('');
    return `<div class="rolagem-tabela"><table class="tabela-dados"><thead><tr>${cabecalho}</tr></thead><tbody>${corpo}</tbody></table></div>`;
  }

  async function carregarPostgres() {
    const minhaVersao = ++versaoPostgres;
    const consulta = CONSULTAS_POSTGRES[document.getElementById('pg-consulta').value] || CONSULTAS_POSTGRES.jogadores;
    const alvo = document.getElementById('pg-tabela');
    const json = document.getElementById('pg-json');
    document.getElementById('pg-sql').textContent = consulta.sql;
    alvo.innerHTML = mensagem('Consultando o PostgreSQL…');
    json.textContent = '';

    try {
      const resposta = await buscarJson(consulta.rota());
      let linhas = Array.isArray(resposta) ? resposta : [resposta];
      if (consulta.enriquecer) linhas = await consulta.enriquecer(linhas);
      if (minhaVersao !== versaoPostgres) return; // trocaram a consulta no meio do caminho
      alvo.innerHTML = desenharTabela(linhas, consulta.colunas)
        + `<p class="nota-explorador">${escaparHtml(`${linhas.length} linha(s). ${consulta.observacao}`)}</p>`;
      json.innerHTML = jsonColorido(resposta);
    } catch (erro) {
      if (minhaVersao !== versaoPostgres) return;
      alvo.innerHTML = mensagem(`Não deu pra consultar o PostgreSQL: ${erro.message}`, true);
    }
  }

  // ---------------------------------------------------------------------------
  // MONGODB: DOCUMENTOS JSON
  // ---------------------------------------------------------------------------

  async function buscarDocumentos() {
    documentos = (await buscarJson(`${API.acervo}/jogos`)) || [];
    return documentos;
  }

  function desenharListaDocumentos() {
    const lista = document.getElementById('mongo-lista');
    const filtro = document.getElementById('mongo-filtro').value.trim().toLowerCase();
    const visiveis = documentos.filter((jogo) => !filtro || String(jogo.nome || '').toLowerCase().includes(filtro));
    if (!documentos.length) {
      lista.innerHTML = '<li class="vazio">A coleção jogos está vazia. Rode o seed.</li>';
      return;
    }
    if (!visiveis.length) {
      lista.innerHTML = '<li class="vazio">Nenhum documento com esse nome.</li>';
      return;
    }
    lista.innerHTML = visiveis.map((jogo) => {
      const id = String(jogo._id);
      const ativo = id === documentoAberto;
      const campos = Object.keys(jogo).length;
      return `<li><button type="button" class="item-documento${ativo ? ' ativo' : ''}" data-id="${escaparHtml(id)}" aria-pressed="${ativo}">
        <strong>${escaparHtml(jogo.nome)}</strong>
        <small>${escaparHtml(jogo.categoria || 'sem categoria')} · ${campos} campos</small>
      </button></li>`;
    }).join('');
  }

  async function abrirDocumento(id) {
    documentoAberto = id;
    desenharListaDocumentos();
    document.getElementById('mongo-consulta').textContent = `db.jogos.findOne({ _id: ObjectId("${id}") })`;
    const destino = document.getElementById('mongo-json');
    destino.textContent = 'Buscando o documento…';
    try {
      // busca de novo pelo id (e não usa o da lista) pra mostrar exatamente o que o GET /jogos/:id devolve
      const documento = await buscarJson(`${API.acervo}/jogos/${encodeURIComponent(id)}`);
      if (documentoAberto !== id) return;
      destino.innerHTML = jsonColorido(documento);
    } catch (erro) {
      if (documentoAberto !== id) return;
      destino.textContent = `Não deu pra buscar o documento: ${erro.message}`;
    }
  }

  async function carregarMongo() {
    const lista = document.getElementById('mongo-lista');
    lista.innerHTML = '<li class="vazio">Consultando o MongoDB…</li>';
    try {
      await buscarDocumentos();
      desenharListaDocumentos();
      const aindaExiste = documentos.some((jogo) => String(jogo._id) === documentoAberto);
      const escolhido = aindaExiste ? documentoAberto : (documentos[0] && String(documentos[0]._id));
      if (escolhido) {
        abrirDocumento(escolhido);
      } else {
        document.getElementById('mongo-json').textContent = 'Nenhum documento na coleção.';
      }
    } catch (erro) {
      lista.innerHTML = `<li class="vazio erro-explorador">${escaparHtml(`Não deu pra consultar o MongoDB: ${erro.message}`)}</li>`;
    }
  }

  // ---------------------------------------------------------------------------
  // NEO4J: GRAFO DESENHADO EM SVG
  // ---------------------------------------------------------------------------

  const LARGURA = 760;
  const ALTURA = 520;
  const CENTRO_X = LARGURA / 2;
  const CENTRO_Y = ALTURA / 2;
  const RAIO_VIZINHOS = 140;   // anel das mecânicas e designers
  const RAIO_PARECIDOS = 220;  // anel dos jogos parecidos

  function cypherDaVizinhanca(id) {
    return `MATCH (j:Jogo {id: "${id}"})-[r:USA_MECANICA|CRIADO_POR]->(x)\n`
      + 'OPTIONAL MATCH (x)<-[r2:USA_MECANICA|CRIADO_POR]-(outro:Jogo)\n'
      + 'RETURN j, r, x, r2, outro';
  }

  // quebra rótulo comprido em até 2 linhas pra não atropelar os vizinhos
  function rotuloSvg(texto, x, y, classe) {
    const palavras = String(texto).split(' ');
    let linhas = [String(texto)];
    if (texto.length > 16 && palavras.length > 1) {
      let melhor = 1;
      let menorDiferenca = Infinity;
      for (let i = 1; i < palavras.length; i++) {
        const diferenca = Math.abs(palavras.slice(0, i).join(' ').length - palavras.slice(i).join(' ').length);
        if (diferenca < menorDiferenca) { menorDiferenca = diferenca; melhor = i; }
      }
      linhas = [palavras.slice(0, melhor).join(' '), palavras.slice(melhor).join(' ')];
    }
    const tspans = linhas.map((linha, i) =>
      `<tspan x="${x.toFixed(1)}" dy="${i === 0 ? 0 : 13}">${escaparHtml(linha)}</tspan>`).join('');
    return `<text class="${classe}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${tspans}</text>`;
  }

  // média de ângulos (no círculo, 350° e 10° têm média 0°, não 180°)
  function mediaAngular(angulos) {
    let x = 0;
    let y = 0;
    angulos.forEach((a) => { x += Math.cos(a); y += Math.sin(a); });
    return Math.atan2(y, x);
  }

  // afasta os jogos parecidos que ficaram muito perto um do outro no anel externo
  function espalharAngulos(itens, folgaMinima) {
    const ordenados = [...itens].sort((a, b) => a.angulo - b.angulo);
    for (let rodada = 0; rodada < 40; rodada++) {
      let mexeu = false;
      for (let i = 0; i < ordenados.length; i++) {
        const atual = ordenados[i];
        const proximo = ordenados[(i + 1) % ordenados.length];
        if (atual === proximo) break;
        let folga = proximo.angulo - atual.angulo;
        if (i === ordenados.length - 1) folga += Math.PI * 2;
        if (folga < folgaMinima) {
          const empurrao = (folgaMinima - folga) / 2;
          atual.angulo -= empurrao;
          proximo.angulo += empurrao;
          mexeu = true;
        }
      }
      if (!mexeu) break;
    }
  }

  function desenharSvg(jogo, mecanicas, designers, parecidos) {
    // anel interno: tudo que o jogo "toca" no grafo
    const vizinhos = [
      ...mecanicas.map((nome) => ({ chave: `m:${nome}`, rotulo: capitalizar(nome), tipo: 'mecanica', relacao: 'USA_MECANICA' })),
      ...designers.map((nome) => ({ chave: `d:${nome}`, rotulo: nome, tipo: 'designer', relacao: 'CRIADO_POR' })),
    ];
    const passo = (Math.PI * 2) / Math.max(vizinhos.length, 1);
    vizinhos.forEach((no, i) => {
      no.angulo = -Math.PI / 2 + i * passo;
      no.x = CENTRO_X + RAIO_VIZINHOS * Math.cos(no.angulo);
      no.y = CENTRO_Y + RAIO_VIZINHOS * Math.sin(no.angulo);
    });
    const porChave = new Map(vizinhos.map((no) => [no.chave, no]));

    // anel externo: cada jogo parecido fica perto dos nós que ele compartilha
    const externos = parecidos.map((p) => {
      const ligacoes = [
        ...(p.mecanicasEmComum || []).map((nome) => porChave.get(`m:${nome}`)),
        ...(p.designersEmComum || []).map((nome) => porChave.get(`d:${nome}`)),
      ].filter(Boolean);
      const angulo = ligacoes.length ? mediaAngular(ligacoes.map((no) => no.angulo)) : 0;
      return { ...p, ligacoes, angulo };
    });
    espalharAngulos(externos, 0.55);
    externos.forEach((no) => {
      no.x = CENTRO_X + RAIO_PARECIDOS * Math.cos(no.angulo);
      no.y = CENTRO_Y + RAIO_PARECIDOS * Math.sin(no.angulo);
    });

    const nomeJogo = jogo ? jogo.nome : 'Jogo';
    const arestas = [];
    vizinhos.forEach((no) => {
      arestas.push(`<line class="aresta aresta-${no.tipo}" x1="${CENTRO_X}" y1="${CENTRO_Y}" x2="${no.x.toFixed(1)}" y2="${no.y.toFixed(1)}">`
        + `<title>${escaparHtml(`(${nomeJogo})-[:${no.relacao}]->(${no.rotulo})`)}</title></line>`);
    });
    externos.forEach((ext) => {
      ext.ligacoes.forEach((no) => {
        arestas.push(`<line class="aresta aresta-parecido" x1="${ext.x.toFixed(1)}" y1="${ext.y.toFixed(1)}" x2="${no.x.toFixed(1)}" y2="${no.y.toFixed(1)}">`
          + `<title>${escaparHtml(`(${ext.nome})-[:${no.relacao}]->(${no.rotulo})`)}</title></line>`);
      });
    });

    const nos = [];
    externos.forEach((ext) => {
      const motivo = `${ext.pontuacao} pt(s): ${ext.ligacoes.map((no) => no.rotulo).join(', ')}`;
      nos.push(`<g class="no no-parecido" data-id="${escaparHtml(ext.jogoId)}" tabindex="0" role="button"
          aria-label="${escaparHtml(`Centralizar em ${ext.nome}`)}">
        <title>${escaparHtml(`${ext.nome} — ${motivo}. Clique pra centralizar.`)}</title>
        <circle cx="${ext.x.toFixed(1)}" cy="${ext.y.toFixed(1)}" r="22"></circle>
        <text class="pontos-no" x="${ext.x.toFixed(1)}" y="${(ext.y + 4).toFixed(1)}" text-anchor="middle">${escaparHtml(String(ext.pontuacao))}</text>
        ${rotuloSvg(ext.nome, ext.x, ext.y + 36, 'rotulo-no rotulo-parecido')}
      </g>`);
    });
    vizinhos.forEach((no) => {
      nos.push(`<g class="no no-${no.tipo}">
        <title>${escaparHtml(`:${no.tipo === 'mecanica' ? 'Mecanica' : 'Designer'} {nome: "${no.rotulo}"}`)}</title>
        <circle cx="${no.x.toFixed(1)}" cy="${no.y.toFixed(1)}" r="15"></circle>
        ${rotuloSvg(no.rotulo, no.x, no.y + 28, 'rotulo-no')}
      </g>`);
    });
    nos.push(`<g class="no no-centro">
      <title>${escaparHtml(`:Jogo {nome: "${nomeJogo}"}`)}</title>
      <circle cx="${CENTRO_X}" cy="${CENTRO_Y}" r="30"></circle>
      <text class="rotulo-centro" x="${CENTRO_X}" y="${CENTRO_Y + 4}" text-anchor="middle">:Jogo</text>
      ${rotuloSvg(nomeJogo, CENTRO_X, CENTRO_Y + 48, 'rotulo-no rotulo-nome-centro')}
    </g>`);

    return `<svg class="svg-grafo" viewBox="0 0 ${LARGURA} ${ALTURA}" role="img"
        aria-label="${escaparHtml(`Grafo de ${nomeJogo}: ${mecanicas.length} mecânicas, ${designers.length} designers e ${parecidos.length} jogos parecidos`)}">
      <g>${arestas.join('')}</g>
      <g>${nos.join('')}</g>
    </svg>`;
  }

  async function desenharGrafo(id) {
    const minhaVersao = ++versaoGrafo;
    const area = document.getElementById('neo-grafo');
    const select = document.getElementById('neo-jogo');
    if (select.value !== id) select.value = id;
    document.getElementById('neo-cypher').textContent = cypherDaVizinhanca(id);
    area.innerHTML = mensagem('Percorrendo o grafo no Neo4j…');

    const jogo = documentos.find((d) => String(d._id) === id);
    try {
      const [doGrafo, parecidos] = await Promise.all([
        buscarJson(`${API.afinidades}/jogos/${encodeURIComponent(id)}/mecanicas`),
        buscarJson(`${API.afinidades}/similares/${encodeURIComponent(id)}`),
      ]);
      if (minhaVersao !== versaoGrafo) return;
      // as mecânicas vêm do grafo (já normalizadas em minúsculas);
      // os designers são os mesmos nomes que o acervo mandou pro grafo
      const designers = jogo && Array.isArray(jogo.designers) ? jogo.designers.map((d) => String(d).trim()).filter(Boolean) : [];
      area.innerHTML = desenharSvg(jogo, doGrafo.mecanicas || [], designers, parecidos || []);
    } catch (erro) {
      if (minhaVersao !== versaoGrafo) return;
      const dica = erro.status === 404
        ? 'Esse jogo ainda não está no grafo. Clique em "Reconstruir grafo" nas ações lá em cima.'
        : `Não deu pra consultar o Neo4j: ${erro.message}`;
      area.innerHTML = mensagem(dica, true);
    }
  }

  async function carregarNeo4j() {
    const select = document.getElementById('neo-jogo');
    const area = document.getElementById('neo-grafo');
    area.innerHTML = mensagem('Buscando a lista de jogos…');
    try {
      await buscarDocumentos();
      if (!documentos.length) {
        select.innerHTML = '<option value="">(acervo vazio)</option>';
        area.innerHTML = mensagem('O acervo está vazio. Rode o seed pra ter o que desenhar.');
        return;
      }
      const anterior = select.value;
      const ordenados = [...documentos].sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
      select.innerHTML = ordenados.map((jogo) =>
        `<option value="${escaparHtml(String(jogo._id))}">${escaparHtml(jogo.nome)}</option>`).join('');
      // começa num jogo que rende um grafo bonito (mesmo designer de outros dois)
      const preferido = ordenados.find((jogo) => String(jogo._id) === anterior)
        || ordenados.find((jogo) => jogo.nome === '7 Wonders')
        || ordenados[0];
      desenharGrafo(String(preferido._id));
    } catch (erro) {
      area.innerHTML = mensagem(`Não deu pra buscar a lista de jogos no acervo: ${erro.message}`, true);
    }
  }

  // ---------------------------------------------------------------------------
  // LINKS PARA AS INTERFACES PRONTAS DE CADA BANCO
  // ---------------------------------------------------------------------------

  // se o config.js apontar pra outro host, os links das interfaces acompanham
  function ajustarLinks() {
    let host = 'localhost';
    try { host = new URL(API.jogadores).hostname; } catch (_) { /* mantém localhost */ }
    const adminer = document.getElementById('link-adminer');
    const mongoExpress = document.getElementById('link-mongo-express');
    const neo4jBrowser = document.getElementById('link-neo4j-browser-explorador');
    if (adminer) adminer.href = `http://${host}:8082/?pgsql=postgres&username=ludoteca&db=ludoteca&ns=public`;
    if (mongoExpress) mongoExpress.href = `http://${host}:8081/db/ludoteca/jogos`;
    if (neo4jBrowser) neo4jBrowser.href = `http://${host}:7474`;
  }

  // ---------------------------------------------------------------------------
  // INÍCIO
  // ---------------------------------------------------------------------------

  function iniciarExplorador() {
    if (!document.querySelector('.explorador')) return;

    document.querySelectorAll('.aba-explorador').forEach((aba) => {
      aba.addEventListener('click', () => abrirAba(aba.dataset.aba));
      aba.addEventListener('keydown', navegarComTeclado);
    });

    document.querySelectorAll('[data-recarregar]').forEach((botao) => {
      botao.addEventListener('click', () => recarregar(botao.dataset.recarregar));
    });

    document.getElementById('pg-consulta').addEventListener('change', carregarPostgres);
    document.getElementById('mongo-filtro').addEventListener('input', desenharListaDocumentos);
    document.getElementById('mongo-lista').addEventListener('click', (evento) => {
      const botao = evento.target.closest('[data-id]');
      if (botao) abrirDocumento(botao.dataset.id);
    });

    document.getElementById('neo-jogo').addEventListener('change', (evento) => {
      if (evento.target.value) desenharGrafo(evento.target.value);
    });
    // clicar (ou Enter/Espaço) num jogo parecido recentraliza o grafo nele
    const areaGrafo = document.getElementById('neo-grafo');
    const centralizar = (evento) => {
      const no = evento.target.closest('.no-parecido[data-id]');
      if (!no) return;
      if (evento.type === 'keydown' && evento.key !== 'Enter' && evento.key !== ' ') return;
      evento.preventDefault();
      desenharGrafo(no.dataset.id);
    };
    areaGrafo.addEventListener('click', centralizar);
    areaGrafo.addEventListener('keydown', centralizar);

    ajustarLinks();
    abrirAba('postgres');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarExplorador);
  } else {
    iniciarExplorador();
  }
})();
