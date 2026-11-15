const mongoose = require('mongoose');
const { Jogo } = require('./modelo');
const JOGOS = require('./jogos-iniciais');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/ludoteca';
const AFINIDADES_URL = (process.env.AFINIDADES_URL || 'http://afinidades-api:4003').replace(/\/+$/, '');

async function popular() {
  await mongoose.connect(MONGO_URL, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
  console.log('[seed] conectado ao MongoDB');

  const removidos = await Jogo.deleteMany({});
  console.log(`[seed] ${removidos.deletedCount} jogo(s) antigo(s) apagado(s)`);

  const agora = Date.now();
  const documentos = JOGOS.map((jogo, i) => ({ ...jogo, criadoEm: new Date(agora - i * 60 * 1000) }));

  const inseridos = await Jogo.insertMany(documentos);
  console.log(`[seed] ${inseridos.length} jogos inseridos no acervo`);

  await Jogo.syncIndexes();
  console.log('[seed] índices conferidos (busca_textual, categoria+criadoEm, faixa de jogadores)');
}

async function pedirReconstrucaoDoGrafo() {
  try {
    const resposta = await fetch(`${AFINIDADES_URL}/sync`, {
      method: 'POST',
      signal: AbortSignal.timeout(30 * 1000)
    });
    const corpo = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new Error(corpo.erro || `status ${resposta.status}`);
    console.log(`[seed] grafo reconstruído no Neo4j: ${corpo.jogos} jogos, ${corpo.mecanicas} mecânicas, ${corpo.designers} designers, ${corpo.relacoes} relações`);
  } catch (erro) {
    console.warn(`[seed] não consegui sincronizar o grafo agora (${erro.message}).`);
    console.warn('[seed] quando o serviço de afinidades estiver no ar, rode: curl -X POST http://localhost:4003/sync');
  }
}

async function principal() {
  try {
    await popular();
  } catch (erro) {
    console.error('[seed] falhou ao popular o acervo:', erro.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }

  await pedirReconstrucaoDoGrafo();
  await mongoose.disconnect().catch(() => {});
  console.log('[seed] pronto!');
  process.exit(0);
}

principal();
