// modelo.js — o "molde" de um Jogo dentro do MongoDB
//
// Fica num arquivo separado porque tanto a API (index.js) quanto o seed.js
// precisam do MESMO schema. Se cada um declarasse o seu, uma hora eles iam
// divergir (um campo a mais aqui, uma validação a menos ali) e o seed acabaria
// gravando coisa que a API nem reconhece.
//
// Por que documento e não tabela? Jogo de tabuleiro é um bicho bem irregular:
// tem jogo com 2 expansões e jogo sem nenhuma, tem jogo com 1 designer e jogo
// com 3, a lista de mecânicas varia de tamanho, a faixa de jogadores é um
// objetinho {min, max}... No relacional isso viraria umas 4 tabelas + JOINs só
// pra montar a página de detalhe. No Mongo o jogo inteiro mora num documento só
// e vem numa leitura só.

const mongoose = require('mongoose');

// lista fechada de categorias — o frontend usa exatamente esses textos nos chips
// e nas capas geradas, então qualquer coisa fora daqui é barrada pelo enum
const CATEGORIAS = ['Estratégia', 'Família', 'Cooperativo', 'Party', 'Cartas', 'Abstrato', 'Outros'];

// campos que são lista de texto e que a gente quer sempre "limpinhos"
const CAMPOS_DE_LISTA = ['designers', 'mecanicas', 'tags'];

// tira espaços das pontas, joga fora item vazio e remove repetido.
// A comparação de repetido ignora maiúscula/minúscula ("Draft" e "draft" são
// a mesma mecânica), mas a gente guarda a grafia da primeira ocorrência.
function limparLista(lista) {
  const vistos = new Set();
  const resultado = [];
  for (const item of lista) {
    if (item === null || item === undefined) continue;
    const texto = String(item).trim();
    if (!texto) continue;
    const chave = texto.toLocaleLowerCase('pt-BR');
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    resultado.push(texto);
  }
  return resultado;
}

// expansão é um subdocumento embutido no próprio jogo. Desliguei o _id dele
// porque ninguém busca expansão sozinha — ela só existe "dentro" do jogo,
// então um ObjectId por expansão seria só byte desperdiçado
const expansaoSchema = new mongoose.Schema({
  nome: { type: String, required: [true, 'Toda expansão precisa de um nome'], trim: true },
  ano:  Number
}, { _id: false });

// as mensagens personalizadas (o segundo item dos arrays) existem pra API
// devolver um erro que dá pra mostrar direto na tela, em vez daquele
// "Path `ano` (1700) is less than minimum allowed value" que ninguém entende
const jogoSchema = new mongoose.Schema({
  nome: {
    type: String,
    required: [true, 'O nome do jogo é obrigatório'],
    trim: true,
    maxlength: [120, 'O nome do jogo pode ter no máximo 120 caracteres']
  },
  categoria: {
    type: String,
    enum: { values: CATEGORIAS, message: `Categoria inválida. Use uma destas: ${CATEGORIAS.join(', ')}` },
    default: 'Outros'
  },
  descricao: String,
  ano: {
    type: Number,
    min: [1800, 'O ano precisa estar entre 1800 e 2100'],
    max: [2100, 'O ano precisa estar entre 1800 e 2100']
  },
  editora:   String,
  designers: [String],
  // faixa de jogadores como objeto aninhado: fica legível no documento e
  // ainda dá pra indexar os dois campos juntos (ver índices lá embaixo)
  jogadores: {
    min: {
      type: Number,
      min: [1, 'O mínimo de jogadores precisa estar entre 1 e 100'],
      max: [100, 'O mínimo de jogadores precisa estar entre 1 e 100']
    },
    max: {
      type: Number,
      min: [1, 'O máximo de jogadores precisa estar entre 1 e 100'],
      max: [100, 'O máximo de jogadores precisa estar entre 1 e 100']
    }
  },
  duracaoMinutos: { type: Number, min: [1, 'A duração precisa ser de pelo menos 1 minuto'] },
  idadeMinima: {
    type: Number,
    min: [0, 'A idade mínima precisa estar entre 0 e 99'],
    max: [99, 'A idade mínima precisa estar entre 0 e 99']
  },
  complexidade: {
    type: Number,
    min: [1, 'A complexidade vai de 1 a 5'],
    max: [5, 'A complexidade vai de 1 a 5']
  },
  mecanicas: [String],
  expansoes: [expansaoSchema],
  comoJogar: String,
  imagem:    String,   // opcional: sem imagem o frontend desenha uma capa sozinho
  tags:      [String],
  criadoEm:  { type: Date, default: Date.now }
});

// validações que dependem de MAIS DE UM campo ao mesmo tempo. O validator de
// campo só enxerga o próprio valor, então a regra "max >= min" tem que ficar
// aqui. Usei pre('validate') (e não pre('save')) porque ele roda antes dos
// validators — assim a limpeza das listas acontece antes de qualquer checagem
// e o erro de faixa sai junto com os outros erros numa resposta só.
jogoSchema.pre('validate', function () {
  // 1) listas de texto: trim, sem vazios, sem repetidos
  for (const campo of CAMPOS_DE_LISTA) {
    const atual = this.get(campo);
    if (!Array.isArray(atual)) continue;
    const limpa = limparLista(atual);
    // só reescreve se mudou alguma coisa, pra não marcar o campo como
    // modificado à toa (o que geraria um $set desnecessário no update)
    const mudou = limpa.length !== atual.length || limpa.some((valor, i) => valor !== atual[i]);
    if (mudou) this.set(campo, limpa);
  }

  // 2) linha de expansão totalmente em branco (sem nome e sem ano) vinda do
  // formulário é descartada. Se tiver ano mas faltar o nome, aí deixa o
  // validator reclamar, porque provavelmente a pessoa esqueceu de digitar
  if (Array.isArray(this.expansoes) && this.expansoes.length > 0) {
    const preenchidas = this.expansoes.filter((expansao) => {
      const nome = typeof expansao.nome === 'string' ? expansao.nome.trim() : expansao.nome;
      const semAno = expansao.ano === null || expansao.ano === undefined;
      return !(semAno && !nome);
    });
    if (preenchidas.length !== this.expansoes.length) {
      this.set('expansoes', preenchidas.map((expansao) => ({ nome: expansao.nome, ano: expansao.ano })));
    }
  }

  // 3) faixa de jogadores coerente (só checa se as duas pontas vieram)
  const min = this.get('jogadores.min');
  const max = this.get('jogadores.max');
  if (typeof min === 'number' && typeof max === 'number' && max < min) {
    this.invalidate(
      'jogadores.max',
      `O máximo de jogadores (${max}) não pode ser menor que o mínimo (${min})`,
      max
    );
  }
});

// ---------------------------------------------------------------------------
// ÍNDICES — a parte de "tuning" do acervo
// ---------------------------------------------------------------------------

// 1) Índice de texto para a busca do catálogo (?q=).
// Sem ele, buscar uma palavra seria um COLLSCAN com regex em todo documento.
// Com ele o Mongo monta um índice invertido (palavra -> documentos), aplica
// stemming em português ("cartas" e "carta" viram o mesmo termo) e ignora
// stopwords ("de", "com", "o"...).
// Os pesos dizem o que importa mais na hora de ordenar por relevância: achar a
// palavra no NOME vale 10x mais do que achar na descrição, e mecânica/designer
// valem mais que tag. Assim quem busca "Bauza" vê primeiro os jogos dele, e não
// um jogo qualquer que só cita o nome dele no meio do texto.
// Detalhe: a coleção só pode ter UM índice de texto, por isso todos os campos
// pesquisáveis vão juntos nesse mesmo índice.
jogoSchema.index(
  { nome: 'text', mecanicas: 'text', designers: 'text', tags: 'text', descricao: 'text' },
  {
    weights: { nome: 10, mecanicas: 5, designers: 5, tags: 3, descricao: 1 },
    default_language: 'portuguese',
    name: 'busca_textual'
  }
);

// 2) Índice composto categoria + data de criação (decrescente).
// A tela de jogos filtra por categoria e mostra os mais novos primeiro. Com
// esse índice o Mongo pula direto para o pedaço da categoria pedida e os
// documentos já saem na ordem certa — não precisa ordenar em memória
// (o famoso SORT stage que aparece no explain() quando falta índice).
// A ordem dos campos importa: igualdade (categoria) antes, ordenação (criadoEm) depois.
jogoSchema.index({ categoria: 1, criadoEm: -1 });

// 3) Índice composto da faixa de jogadores.
// O filtro "quantos jogadores?" vira jogadores.min <= n <= jogadores.max, que
// são duas comparações de intervalo. Com o índice o Mongo percorre só um
// trecho das chaves em vez de abrir todos os documentos pra comparar.
jogoSchema.index({ 'jogadores.min': 1, 'jogadores.max': 1 });

// terceiro argumento = nome da coleção. Deixo explícito pra não depender da
// pluralização automática do Mongoose (que é pensada pra inglês)
const Jogo = mongoose.model('Jogo', jogoSchema, 'jogos');

module.exports = { Jogo, CATEGORIAS };
