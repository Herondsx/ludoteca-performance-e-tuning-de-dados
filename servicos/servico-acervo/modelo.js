const mongoose = require('mongoose');

const CATEGORIAS = ['Estratégia', 'Família', 'Cooperativo', 'Party', 'Cartas', 'Abstrato', 'Outros'];

const CAMPOS_DE_LISTA = ['designers', 'mecanicas', 'tags'];

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

const expansaoSchema = new mongoose.Schema({
  nome: { type: String, required: [true, 'Toda expansão precisa de um nome'], trim: true },
  ano:  Number
}, { _id: false });

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
  imagem:    String,
  tags:      [String],
  criadoEm:  { type: Date, default: Date.now }
});

jogoSchema.pre('validate', function () {
  for (const campo of CAMPOS_DE_LISTA) {
    const atual = this.get(campo);
    if (!Array.isArray(atual)) continue;
    const limpa = limparLista(atual);
    const mudou = limpa.length !== atual.length || limpa.some((valor, i) => valor !== atual[i]);
    if (mudou) this.set(campo, limpa);
  }

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

jogoSchema.index(
  { nome: 'text', mecanicas: 'text', designers: 'text', tags: 'text', descricao: 'text' },
  {
    weights: { nome: 10, mecanicas: 5, designers: 5, tags: 3, descricao: 1 },
    default_language: 'portuguese',
    name: 'busca_textual'
  }
);

jogoSchema.index({ categoria: 1, criadoEm: -1 });

jogoSchema.index({ 'jogadores.min': 1, 'jogadores.max': 1 });

const Jogo = mongoose.model('Jogo', jogoSchema, 'jogos');

module.exports = { Jogo, CATEGORIAS };
