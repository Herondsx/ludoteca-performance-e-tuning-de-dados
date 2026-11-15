const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORTA = Number(process.env.PORT) || 4001;
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://ludoteca:ludoteca123@localhost:5432/ludoteca';
const JWT_SEGREDO = process.env.JWT_SEGREDO || 'ludoteca_dev_segredo';

const CUSTO_BCRYPT = 10;

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('[pool] conexão ociosa com o PostgreSQL caiu:', err.message);
});

const REGEX_JOGO_ID = /^[a-f0-9]{24}$/i;
const REGEX_EMAIL = /^[^\s@]+@[^\s@]+$/;
const MAIOR_INTEIRO_PG = 2147483647;

const pausa = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizarEmail(email) {
  return email.trim().toLowerCase();
}

function normalizarJogoId(jogoId) {
  return typeof jogoId === 'string' && REGEX_JOGO_ID.test(jogoId) ? jogoId.toLowerCase() : null;
}

function lerIdInteiro(texto) {
  if (!/^\d{1,10}$/.test(texto)) return null;
  const id = Number(texto);
  return id >= 1 && id <= MAIOR_INTEIRO_PG ? id : null;
}

function ehTextoPreenchido(valor) {
  return typeof valor === 'string' && valor.trim() !== '';
}

function gerarToken(jogador) {
  return jwt.sign({ id: jogador.id, email: jogador.email }, JWT_SEGREDO, { expiresIn: '7d' });
}

const COLUNAS_PUBLICAS = 'id, nome, email, criado_em AS "criadoEm"';

const HASH_FALSO = bcrypt.hashSync('senha-que-ninguem-usa', CUSTO_BCRYPT);

function lerJogadorDoToken(req) {
  const cabecalho = req.headers.authorization || '';
  const [tipo, token] = cabecalho.split(' ');
  if (!token || !/^bearer$/i.test(tipo)) return null;
  try {
    const payload = jwt.verify(token, JWT_SEGREDO, { algorithms: ['HS256'] });
    if (!payload || !Number.isInteger(payload.id)) return null;
    return { id: payload.id, email: payload.email };
  } catch {
    return null;
  }
}

function exigirLogin(req, res, next) {
  const jogador = lerJogadorDoToken(req);
  if (!jogador) return res.status(401).json({ erro: 'Faça login para continuar' });
  req.jogador = jogador;
  next();
}

function loginOpcional(req, res, next) {
  const jogador = lerJogadorDoToken(req);
  if (jogador) req.jogador = jogador;
  next();
}

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

async function criarTabelas() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jogadores (
      id          SERIAL PRIMARY KEY,
      nome        VARCHAR(100) NOT NULL,
      email       VARCHAR(150) NOT NULL UNIQUE,
      senha_hash  VARCHAR(255) NOT NULL,
      criado_em   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS favoritos (
      jogador_id    INTEGER     NOT NULL REFERENCES jogadores(id) ON DELETE CASCADE,
      jogo_id       VARCHAR(24) NOT NULL,
      adicionado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (jogador_id, jogo_id)
    );

    CREATE TABLE IF NOT EXISTS visualizacoes (
      id         BIGSERIAL   PRIMARY KEY,
      jogo_id    VARCHAR(24) NOT NULL,
      jogador_id INTEGER     REFERENCES jogadores(id) ON DELETE SET NULL,
      visto_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_visualizacoes_jogo ON visualizacoes (jogo_id);

    CREATE INDEX IF NOT EXISTS idx_visualizacoes_jogador_data ON visualizacoes (jogador_id, visto_em DESC);
  `);
  console.log('[banco] tabelas e índices conferidos');
}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

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

    const senhaHash = await bcrypt.hash(senha, CUSTO_BCRYPT);

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

app.post('/login', async (req, res, next) => {
  try {
    const { email, senha } = req.body || {};
    if (!ehTextoPreenchido(email) || typeof senha !== 'string' || senha === '') {
      return res.status(400).json({ erro: 'Informe e-mail e senha' });
    }

    const { rows } = await pool.query(
      `SELECT ${COLUNAS_PUBLICAS}, senha_hash FROM jogadores WHERE email = $1`,
      [normalizarEmail(email)]
    );
    const registro = rows[0];

    const senhaConfere = await bcrypt.compare(senha, registro ? registro.senha_hash : HASH_FALSO);

    if (!registro || !senhaConfere) {
      return res.status(401).json({ erro: 'Credenciais inválidas' });
    }

    const { senha_hash: _descartado, ...jogador } = registro;
    res.json({ jogador, token: gerarToken(jogador) });
  } catch (err) {
    next(err);
  }
});

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

app.delete('/jogadores/:id', exigirLogin, async (req, res, next) => {
  try {
    const id = lerIdInteiro(req.params.id);
    if (id === null) return res.status(400).json({ erro: 'O id do jogador precisa ser um número inteiro' });
    if (Number(req.params.id) !== req.jogador.id) {
      return res.status(403).json({ erro: 'Você só pode excluir a sua própria conta' });
    }

    const { rowCount } = await pool.query('DELETE FROM jogadores WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ erro: 'Jogador não encontrado' });
    res.json({ mensagem: 'Conta excluída. Seus favoritos foram apagados e suas visualizações seguem no ranking como anônimas.' });
  } catch (err) {
    next(err);
  }
});

app.post('/visualizacoes', loginOpcional, async (req, res, next) => {
  try {
    const jogoId = normalizarJogoId((req.body || {}).jogoId);
    if (!jogoId) return res.status(400).json({ erro: 'jogoId inválido (esperado um ObjectId de 24 caracteres hexadecimais)' });

    const jogadorId = req.jogador ? req.jogador.id : null;
    const sql = 'INSERT INTO visualizacoes (jogo_id, jogador_id) VALUES ($1, $2)';

    try {
      await pool.query(sql, [jogoId, jogadorId]);
    } catch (err) {
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

app.get('/ranking', async (req, res, next) => {
  try {
    const pedido = Number.parseInt(req.query.limite, 10);
    const limite = Number.isNaN(pedido) ? 10 : Math.min(50, Math.max(1, pedido));

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

app.post('/favoritos/:jogoId', exigirLogin, async (req, res, next) => {
  try {
    const jogoId = normalizarJogoId(req.params.jogoId);
    if (!jogoId) return res.status(400).json({ erro: 'jogoId inválido (esperado um ObjectId de 24 caracteres hexadecimais)' });

    await pool.query(
      `INSERT INTO favoritos (jogador_id, jogo_id)
       VALUES ($1, $2)
       ON CONFLICT (jogador_id, jogo_id) DO NOTHING`,
      [req.jogador.id, jogoId]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ erro: 'Jogador não encontrado' });
    next(err);
  }
});

app.delete('/favoritos/:jogoId', exigirLogin, async (req, res, next) => {
  try {
    const jogoId = normalizarJogoId(req.params.jogoId);
    if (!jogoId) return res.status(400).json({ erro: 'jogoId inválido (esperado um ObjectId de 24 caracteres hexadecimais)' });

    await pool.query('DELETE FROM favoritos WHERE jogador_id = $1 AND jogo_id = $2', [req.jogador.id, jogoId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/historico', exigirLogin, async (req, res, next) => {
  try {
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

app.get('/estatisticas', async (req, res, next) => {
  try {
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

app.get('/saude', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, banco: 'postgresql' });
  } catch (err) {
    res.status(503).json({ ok: false, banco: 'postgresql', erro: `PostgreSQL indisponível: ${err.message}` });
  }
});

app.use((req, res) => {
  res.status(404).json({ erro: `Rota não encontrada: ${req.method} ${req.path}` });
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido' });
  }
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ erro: err.message });
  }
  console.error(`[erro] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ erro: 'Erro interno no serviço de jogadores' });
});

let servidor;

aguardarBanco()
  .then(criarTabelas)
  .then(() => {
    servidor = app.listen(PORTA, () => {
      console.log(`[servico-jogadores] ouvindo na porta ${PORTA}`);
    });
  })
  .catch((err) => {
    console.error('[servico-jogadores] falha na inicialização:', err.message);
    process.exit(1);
  });

function desligar(sinal) {
  console.log(`[servico-jogadores] ${sinal} recebido, encerrando...`);
  const fecharPool = () =>
    pool.end().catch(() => {}).finally(() => process.exit(0));
  if (servidor) servidor.close(fecharPool);
  else fecharPool();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => desligar('SIGTERM'));
process.on('SIGINT', () => desligar('SIGINT'));
