// =====================================================================
// servico-jogadores  →  Node + Express + PostgreSQL  (porta 4001)
// ---------------------------------------------------------------------
// Esse serviço cuida das CONTAS dos jogadores (cadastro e login com
// bcrypt + JWT), dos FAVORITOS de cada um, do HISTÓRICO de jogos vistos
// e do RANKING de jogos mais acessados.
//
// Por que relacional (PostgreSQL) e não Mongo/Neo4j aqui?
//  - os dados são bem "certinhos": todo jogador tem nome, e-mail e senha,
//    sem campo opcional maluco. Tabela com colunas fixas encaixa perfeito;
//  - e-mail tem que ser único → quem garante é a constraint UNIQUE do
//    próprio banco, e não um "SELECT antes do INSERT" (que daria corrida
//    se duas pessoas cadastrassem o mesmo e-mail no mesmo instante);
//  - integridade referencial de graça com FOREIGN KEY: apagou o jogador,
//    os favoritos dele somem juntos (CASCADE) e as visualizações viram
//    anônimas (SET NULL), continuando a contar no ranking;
//  - ranking e histórico são agregações (COUNT / MAX / GROUP BY), que é
//    justamente o ponto forte de SQL + índice B-tree.
//
// Os jogos em si moram no MongoDB (servico-acervo). Aqui a gente só guarda
// o _id do jogo (string de 24 caracteres hexadecimais) como referência
// "fraca" — não dá pra ter FK entre bancos diferentes, e tudo bem.
// =====================================================================

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORTA = Number(process.env.PORT) || 4001;
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://ludoteca:ludoteca123@localhost:5432/ludoteca';
const JWT_SEGREDO = process.env.JWT_SEGREDO || 'ludoteca_dev_segredo';

// custo do bcrypt: cada +1 dobra o tempo do hash. 10 fica na casa de
// dezenas de ms — lento o bastante pra atrapalhar força bruta, rápido o
// bastante pra não travar o cadastro/login durante a apresentação.
const CUSTO_BCRYPT = 10;

// -------------------------------------------------------------------
// Pool de conexões (tuning!)
// Abrir conexão com o Postgres custa caro (handshake TCP + autenticação
// + um processo novo no servidor). Com o Pool a gente abre poucas
// conexões e reaproveita entre as requisições, em vez de abrir/fechar
// uma por request. 10 conexões sobram pra uma demo e não sobrecarregam
// o container do banco.
// -------------------------------------------------------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 20000,       // conexão parada há 20s é devolvida pro banco
  connectionTimeoutMillis: 5000   // se o banco não responder em 5s, falha rápido em vez de pendurar a request
});

// se uma conexão ociosa do pool cair (ex.: banco reiniciou), o pg emite
// 'error'. Sem esse listener o Node derrubaria o processo inteiro.
pool.on('error', (err) => {
  console.error('[pool] conexão ociosa com o PostgreSQL caiu:', err.message);
});

// -------------------------------------------------------------------
// Validações e utilitários
// -------------------------------------------------------------------

// _id do MongoDB = 24 caracteres hexadecimais. Validar aqui evita lixo
// no ranking/favoritos e deixa a coluna VARCHAR(24) sempre consistente.
const REGEX_JOGO_ID = /^[a-f0-9]{24}$/i;
const REGEX_EMAIL = /^[^\s@]+@[^\s@]+$/; // checagem bem básica, só pra barrar coisa claramente errada
const MAIOR_INTEIRO_PG = 2147483647;     // limite do tipo INTEGER (SERIAL) no Postgres

const pausa = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// e-mail SEMPRE passa por aqui antes de gravar ou buscar: assim
// "Fulano@Email.com " e "fulano@email.com" são o mesmo jogador e a
// constraint UNIQUE funciona de verdade.
function normalizarEmail(email) {
  return email.trim().toLowerCase();
}

// o ObjectId vem do Mongo em minúsculas; normalizar garante que o mesmo
// jogo nunca apareça duas vezes no ranking só por diferença de caixa.
function normalizarJogoId(jogoId) {
  return typeof jogoId === 'string' && REGEX_JOGO_ID.test(jogoId) ? jogoId.toLowerCase() : null;
}

// :id da URL precisa ser inteiro positivo e caber num INTEGER do Postgres.
// Sem isso, "/jogadores/abc" viraria erro 500 do banco em vez de um 400 claro.
function lerIdInteiro(texto) {
  if (!/^\d{1,10}$/.test(texto)) return null;
  const id = Number(texto);
  return id >= 1 && id <= MAIOR_INTEIRO_PG ? id : null;
}

function ehTextoPreenchido(valor) {
  return typeof valor === 'string' && valor.trim() !== '';
}

function gerarToken(jogador) {
  // payload pequeno de propósito: só o necessário pra identificar quem é.
  // Nada de senha ou dado sensível aqui (o JWT é só assinado, não criptografado).
  return jwt.sign({ id: jogador.id, email: jogador.email }, JWT_SEGREDO, { expiresIn: '7d' });
}

// colunas "públicas" do jogador — a senha_hash NUNCA sai daqui.
// O alias com aspas já devolve o campo em camelCase pro JSON.
const COLUNAS_PUBLICAS = 'id, nome, email, criado_em AS "criadoEm"';

// hash "de mentira" usado no login quando o e-mail não existe: a gente
// roda o bcrypt.compare do mesmo jeito, pra resposta demorar igual nos
// dois casos e ninguém descobrir quais e-mails estão cadastrados medindo tempo.
const HASH_FALSO = bcrypt.hashSync('senha-que-ninguem-usa', CUSTO_BCRYPT);

// -------------------------------------------------------------------
// Middlewares de autenticação
// -------------------------------------------------------------------

// extrai e valida o token do cabeçalho "Authorization: Bearer <token>".
// Devolve { id, email } ou null (nunca lança erro).
function lerJogadorDoToken(req) {
  const cabecalho = req.headers.authorization || '';
  const [tipo, token] = cabecalho.split(' ');
  if (!token || !/^bearer$/i.test(tipo)) return null;
  try {
    // fixar o algoritmo impede o truque de mandar um token com outro "alg"
    const payload = jwt.verify(token, JWT_SEGREDO, { algorithms: ['HS256'] });
    if (!payload || !Number.isInteger(payload.id)) return null;
    return { id: payload.id, email: payload.email };
  } catch {
    return null; // expirado, assinatura errada, malformado...
  }
}

// rotas que só fazem sentido logado (favoritos, histórico, editar conta)
function exigirLogin(req, res, next) {
  const jogador = lerJogadorDoToken(req);
  if (!jogador) return res.status(401).json({ erro: 'Faça login para continuar' });
  req.jogador = jogador;
  next();
}

// rotas que funcionam pros dois casos (ex.: registrar visualização).
// Token inválido aqui NÃO é erro: o visitante só segue como anônimo.
function loginOpcional(req, res, next) {
  const jogador = lerJogadorDoToken(req);
  if (jogador) req.jogador = jogador;
  next();
}

// -------------------------------------------------------------------
// Banco: espera subir e cria as tabelas
// -------------------------------------------------------------------

// no docker compose o container do Postgres pode estar "de pé" mas ainda
// sem aceitar conexão. Em vez de morrer na primeira tentativa, a gente
// insiste algumas vezes com uma pausa entre elas.
async function aguardarBanco(tentativas = 15, intervaloMs = 2000) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      await pool.query('SELECT 1');
      console.log('[banco] PostgreSQL respondendo');
      return;
    } catch (err) {
      console.log(`[banco] PostgreSQL ainda indisponível (tentativa ${i}/${tentativas}): ${err.message}`);
      if (i < tentativas) await pausa(intervaloMs);
    }
  }
  throw new Error('não foi possível conectar ao PostgreSQL');
}

// tudo com IF NOT EXISTS → pode rodar a cada boot sem apagar nada.
async function criarTabelas() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jogadores (
      id          SERIAL PRIMARY KEY,
      nome        VARCHAR(100) NOT NULL,
      email       VARCHAR(150) NOT NULL UNIQUE,
      senha_hash  VARCHAR(255) NOT NULL,
      criado_em   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    -- chave primária composta (jogador_id, jogo_id):
    --  * impede favoritar o mesmo jogo duas vezes (sem precisar de checagem no código)
    --  * o índice que vem junto com a PK já começa por jogador_id, então
    --    "favoritos do jogador X" e o CASCADE ao apagar o jogador usam índice
    CREATE TABLE IF NOT EXISTS favoritos (
      jogador_id    INTEGER     NOT NULL REFERENCES jogadores(id) ON DELETE CASCADE,
      jogo_id       VARCHAR(24) NOT NULL,
      adicionado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (jogador_id, jogo_id)
    );

    -- cada abertura de página de jogo vira uma linha (log de eventos).
    -- jogador_id pode ser NULL: visitante anônimo ou conta já apagada.
    CREATE TABLE IF NOT EXISTS visualizacoes (
      id         BIGSERIAL   PRIMARY KEY,
      jogo_id    VARCHAR(24) NOT NULL,
      jogador_id INTEGER     REFERENCES jogadores(id) ON DELETE SET NULL,
      visto_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- índice por jogo: contar/filtrar visualizações de um jogo específico
    -- vira busca no índice em vez de varrer a tabela inteira, que é a que
    -- mais cresce no sistema.
    CREATE INDEX IF NOT EXISTS idx_visualizacoes_jogo         ON visualizacoes (jogo_id);

    -- índice composto pro histórico: "WHERE jogador_id = X ORDER BY visto_em DESC"
    -- já encontra as linhas do jogador na ordem certa. De quebra o Postgres
    -- usa esse índice no ON DELETE SET NULL (sem ele, apagar um jogador
    -- faria um seq scan na tabela de visualizações).
    CREATE INDEX IF NOT EXISTS idx_visualizacoes_jogador_data ON visualizacoes (jogador_id, visto_em DESC);
  `);
  console.log('[banco] tabelas e índices conferidos');
}

// -------------------------------------------------------------------
// App Express
// -------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(cors());           // o frontend roda em outra origem (porta 8080)
app.use(express.json());   // corpo JSON → req.body

// ---------- Contas ----------

// POST /cadastro  { nome, email, senha }
app.post('/cadastro', async (req, res, next) => {
  try {
    const { nome, email, senha } = req.body || {};

    if (!ehTextoPreenchido(nome) || !ehTextoPreenchido(email) || typeof senha !== 'string' || senha === '') {
      return res.status(400).json({ erro: 'Informe nome, e-mail e senha' });
    }
    if (senha.length < 6) {
      return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres' });
    }

    const nomeLimpo = nome.trim();
    const emailLimpo = normalizarEmail(email);
    if (nomeLimpo.length > 100) {
      return res.status(400).json({ erro: 'O nome pode ter no máximo 100 caracteres' });
    }
    if (emailLimpo.length > 150 || !REGEX_EMAIL.test(emailLimpo)) {
      return res.status(400).json({ erro: 'E-mail inválido' });
    }

    // bcrypt já embute um salt aleatório no próprio hash
    const senhaHash = await bcrypt.hash(senha, CUSTO_BCRYPT);

    // sem SELECT prévio pra checar e-mail: deixa a constraint UNIQUE
    // decidir (é atômico) e trata o erro 23505 logo abaixo.
    const { rows } = await pool.query(
      `INSERT INTO jogadores (nome, email, senha_hash)
       VALUES ($1, $2, $3)
       RETURNING ${COLUNAS_PUBLICAS}`,
      [nomeLimpo, emailLimpo, senhaHash]
    );

    const jogador = rows[0];
    res.status(201).json({ jogador, token: gerarToken(jogador) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'Este e-mail já está cadastrado' });
    next(err);
  }
});

// POST /login  { email, senha }
app.post('/login', async (req, res, next) => {
  try {
    const { email, senha } = req.body || {};
    if (!ehTextoPreenchido(email) || typeof senha !== 'string' || senha === '') {
      return res.status(400).json({ erro: 'Informe e-mail e senha' });
    }

    // a coluna email tem índice (criado automaticamente pela UNIQUE),
    // então essa busca é direta, não importa quantos jogadores existam
    const { rows } = await pool.query(
      `SELECT ${COLUNAS_PUBLICAS}, senha_hash FROM jogadores WHERE email = $1`,
      [normalizarEmail(email)]
    );
    const registro = rows[0];

    const senhaConfere = await bcrypt.compare(senha, registro ? registro.senha_hash : HASH_FALSO);

    // mesma mensagem pra "e-mail não existe" e "senha errada": não damos
    // dica pra quem estiver tentando adivinhar contas
    if (!registro || !senhaConfere) {
      return res.status(401).json({ erro: 'Credenciais inválidas' });
    }

    const { senha_hash: _descartado, ...jogador } = registro;
    res.json({ jogador, token: gerarToken(jogador) });
  } catch (err) {
    next(err);
  }
});

// GET /jogadores  → lista pública, mais novo primeiro
app.get('/jogadores', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${COLUNAS_PUBLICAS} FROM jogadores ORDER BY criado_em DESC, id DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /jogadores/:id
app.get('/jogadores/:id', async (req, res, next) => {
  try {
    const id = lerIdInteiro(req.params.id);
    if (id === null) return res.status(400).json({ erro: 'O id do jogador precisa ser um número inteiro' });

    const { rows } = await pool.query(`SELECT ${COLUNAS_PUBLICAS} FROM jogadores WHERE id = $1`, [id]);
    if (!rows[0]) return res.status(404).json({ erro: 'Jogador não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /jogadores/:id  { nome?, email? }  — só o dono da conta
app.put('/jogadores/:id', exigirLogin, async (req, res, next) => {
  try {
    const id = lerIdInteiro(req.params.id);
    if (id === null) return res.status(400).json({ erro: 'O id do jogador precisa ser um número inteiro' });
    if (Number(req.params.id) !== req.jogador.id) {
      return res.status(403).json({ erro: 'Você só pode alterar a sua própria conta' });
    }

    const { nome, email } = req.body || {};
    let novoNome = null;
    let novoEmail = null;

    // campo ausente (undefined/null) = "não mexe". Campo enviado vazio
    // ou com tipo errado = erro, pra não gravar nome em branco sem querer.
    if (nome !== undefined && nome !== null) {
      if (!ehTextoPreenchido(nome) || nome.trim().length > 100) {
        return res.status(400).json({ erro: 'Nome inválido (1 a 100 caracteres)' });
      }
      novoNome = nome.trim();
    }
    if (email !== undefined && email !== null) {
      if (!ehTextoPreenchido(email)) return res.status(400).json({ erro: 'E-mail inválido' });
      novoEmail = normalizarEmail(email);
      if (novoEmail.length > 150 || !REGEX_EMAIL.test(novoEmail)) {
        return res.status(400).json({ erro: 'E-mail inválido' });
      }
    }

    // COALESCE($1, nome): se o parâmetro vier NULL, mantém o valor atual.
    // Assim um único UPDATE serve pra "só nome", "só e-mail" ou os dois.
    const { rows } = await pool.query(
      `UPDATE jogadores
          SET nome  = COALESCE($1, nome),
              email = COALESCE($2, email)
        WHERE id = $3
        RETURNING ${COLUNAS_PUBLICAS}`,
      [novoNome, novoEmail, id]
    );
    if (!rows[0]) return res.status(404).json({ erro: 'Jogador não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'Este e-mail já está cadastrado' });
    next(err);
  }
});

// DELETE /jogadores/:id  — só o dono da conta
app.delete('/jogadores/:id', exigirLogin, async (req, res, next) => {
  try {
    const id = lerIdInteiro(req.params.id);
    if (id === null) return res.status(400).json({ erro: 'O id do jogador precisa ser um número inteiro' });
    if (Number(req.params.id) !== req.jogador.id) {
      return res.status(403).json({ erro: 'Você só pode excluir a sua própria conta' });
    }

    // um DELETE só: as FKs fazem o resto (favoritos em CASCADE,
    // visualizações ficam com jogador_id NULL e seguem no ranking)
    const { rowCount } = await pool.query('DELETE FROM jogadores WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ erro: 'Jogador não encontrado' });
    res.json({ mensagem: 'Conta excluída. Seus favoritos foram apagados e suas visualizações seguem no ranking como anônimas.' });
  } catch (err) {
    next(err);
  }
});

// ---------- Visualizações e ranking ----------

// POST /visualizacoes  { jogoId }  — logado ou anônimo
app.post('/visualizacoes', loginOpcional, async (req, res, next) => {
  try {
    const jogoId = normalizarJogoId((req.body || {}).jogoId);
    if (!jogoId) return res.status(400).json({ erro: 'jogoId inválido (esperado um ObjectId de 24 caracteres hexadecimais)' });

    const jogadorId = req.jogador ? req.jogador.id : null;
    const sql = 'INSERT INTO visualizacoes (jogo_id, jogador_id) VALUES ($1, $2)';

    try {
      await pool.query(sql, [jogoId, jogadorId]);
    } catch (err) {
      // 23503 = violação de FK: o token ainda é válido, mas a conta foi
      // apagada. Em vez de perder a visualização, grava como anônima.
      if (err.code === '23503' && jogadorId !== null) {
        await pool.query(sql, [jogoId, null]);
      } else {
        throw err;
      }
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /ranking?limite=10  → jogos mais vistos
app.get('/ranking', async (req, res, next) => {
  try {
    const pedido = Number.parseInt(req.query.limite, 10);
    const limite = Number.isNaN(pedido) ? 10 : Math.min(50, Math.max(1, pedido));

    // agregação feita 100% no banco: o Node recebe só N linhas prontas
    // em vez de baixar o log inteiro e contar em JavaScript.
    // COUNT(*)::int → sem o cast o pg devolve BIGINT como string ("12").
    // ORDER BY 2 = "ordena pela 2ª coluna do SELECT" (a contagem).
    // Desempate: quem foi visto mais recentemente aparece antes.
    const { rows } = await pool.query(
      `SELECT jogo_id AS "jogoId", COUNT(*)::int AS visualizacoes
         FROM visualizacoes
        GROUP BY jogo_id
        ORDER BY 2 DESC, MAX(visto_em) DESC
        LIMIT $1`,
      [limite]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------- Favoritos ----------

// GET /favoritos  → favoritos do jogador logado, mais recente primeiro
app.get('/favoritos', exigirLogin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT jogo_id AS "jogoId", adicionado_em AS "adicionadoEm"
         FROM favoritos
        WHERE jogador_id = $1
        ORDER BY adicionado_em DESC`,
      [req.jogador.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /favoritos/:jogoId
app.post('/favoritos/:jogoId', exigirLogin, async (req, res, next) => {
  try {
    const jogoId = normalizarJogoId(req.params.jogoId);
    if (!jogoId) return res.status(400).json({ erro: 'jogoId inválido (esperado um ObjectId de 24 caracteres hexadecimais)' });

    // ON CONFLICT DO NOTHING: favoritar de novo não é erro, a operação
    // é idempotente (clicar duas vezes no coração não quebra nada)
    await pool.query(
      `INSERT INTO favoritos (jogador_id, jogo_id)
       VALUES ($1, $2)
       ON CONFLICT (jogador_id, jogo_id) DO NOTHING`,
      [req.jogador.id, jogoId]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    // FK falhou → o jogador do token não existe mais no banco
    if (err.code === '23503') return res.status(404).json({ erro: 'Jogador não encontrado' });
    next(err);
  }
});

// DELETE /favoritos/:jogoId
app.delete('/favoritos/:jogoId', exigirLogin, async (req, res, next) => {
  try {
    const jogoId = normalizarJogoId(req.params.jogoId);
    if (!jogoId) return res.status(400).json({ erro: 'jogoId inválido (esperado um ObjectId de 24 caracteres hexadecimais)' });

    // se já não era favorito, tudo bem: o resultado final é o mesmo
    await pool.query('DELETE FROM favoritos WHERE jogador_id = $1 AND jogo_id = $2', [req.jogador.id, jogoId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Histórico ----------

// GET /historico  → últimos 20 jogos DIFERENTES que o jogador abriu
app.get('/historico', exigirLogin, async (req, res, next) => {
  try {
    // GROUP BY jogo_id + MAX(visto_em): se a pessoa abriu Catan 8 vezes,
    // aparece uma linha só, com a data da última. O filtro por jogador_id
    // cai no índice idx_visualizacoes_jogador_data.
    const { rows } = await pool.query(
      `SELECT jogo_id AS "jogoId", MAX(visto_em) AS "ultimaVez"
         FROM visualizacoes
        WHERE jogador_id = $1
        GROUP BY jogo_id
        ORDER BY "ultimaVez" DESC
        LIMIT 20`,
      [req.jogador.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------- Monitoramento ----------

// GET /estatisticas  → números do card do PostgreSQL no monitor
app.get('/estatisticas', async (req, res, next) => {
  try {
    // 3 contagens numa ida só ao banco (3 subselects) em vez de 3 queries
    // separadas: menos round-trips, e o monitor chama isso a cada 3s.
    const { rows } = await pool.query(`
      SELECT (SELECT COUNT(*)::int FROM jogadores)     AS jogadores,
             (SELECT COUNT(*)::int FROM visualizacoes) AS visualizacoes,
             (SELECT COUNT(*)::int FROM favoritos)     AS favoritos
    `);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /saude  → health check simples
app.get('/saude', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, banco: 'postgresql' });
  } catch (err) {
    res.status(503).json({ ok: false, banco: 'postgresql', erro: `PostgreSQL indisponível: ${err.message}` });
  }
});

// -------------------------------------------------------------------
// Rota inexistente e tratamento central de erros (sempre JSON)
// -------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ erro: `Rota não encontrada: ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // corpo que não é JSON válido (vem do express.json())
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido' });
  }
  // outros erros "do cliente" levantados pelo body-parser (ex.: corpo grande demais)
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ erro: err.message });
  }
  console.error(`[erro] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ erro: 'Erro interno no serviço de jogadores' });
});

// -------------------------------------------------------------------
// Inicialização: espera o banco → cria tabelas → abre a porta
// -------------------------------------------------------------------
let servidor;

aguardarBanco()
  .then(criarTabelas)
  .then(() => {
    servidor = app.listen(PORTA, () => {
      console.log(`[servico-jogadores] ouvindo na porta ${PORTA}`);
    });
  })
  .catch((err) => {
    // sai com código != 0 → o "restart: on-failure" do compose sobe de novo
    console.error('[servico-jogadores] falha na inicialização:', err.message);
    process.exit(1);
  });

// desligamento educado (docker stop manda SIGTERM): para de aceitar
// requisições e devolve as conexões do pool antes de sair.
function desligar(sinal) {
  console.log(`[servico-jogadores] ${sinal} recebido, encerrando...`);
  const fecharPool = () =>
    pool.end().catch(() => {}).finally(() => process.exit(0));
  if (servidor) servidor.close(fecharPool);
  else fecharPool();
  // rede de segurança: se alguma conexão keep-alive segurar o close,
  // sai na marra depois de 5s (o unref não deixa esse timer prender o processo)
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => desligar('SIGTERM'));
process.on('SIGINT', () => desligar('SIGINT'));
