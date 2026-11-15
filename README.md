# Ludoteca

Trabalho de Performance e Tuning de Dados (FEI). O tema é persistência poliglota, então o sistema usa três bancos
diferentes: PostgreSQL, MongoDB e Neo4j.

## Integrantes

| Nome | RA |
|------|----|
| Heron de Souza | 22.223.009-6 |
| João Mateus E. B. da Silva | 22.223.013-8 |
| Vinicius Trivellato | 22.223.022-9 |

## O projeto

A Ludoteca é um catálogo de jogos de tabuleiro. O usuário cria uma conta, procura jogos por nome, categoria ou número
de jogadores, favorita os que gostar e vê o histórico do que abriu. Na página inicial aparece um ranking dos jogos mais
vistos e na página de cada jogo aparecem jogos parecidos com ele.

Dividimos os dados assim:

- **PostgreSQL**: jogadores, favoritos e visualizações. São dados bem estruturados, com e-mail único, chaves
  estrangeiras, e o ranking sai de um `COUNT` com `GROUP BY`.
- **MongoDB**: as fichas dos jogos. Cada jogo tem campos diferentes (lista de mecânicas, designers, expansões, faixa de
  jogadores), então guardar como documento ficou mais simples do que espalhar isso em várias tabelas.
- **Neo4j**: as ligações entre jogos, mecânicas e designers, que é o que usamos pra recomendar jogos parecidos.

Cada banco tem uma API em Node.js (Express) e o frontend é HTML, CSS e JavaScript puro, servido por um nginx. Tudo
roda com docker compose.

| Serviço | Porta | Banco |
|---------|-------|-------|
| jogadores-api | 4001 | PostgreSQL |
| acervo-api | 4002 | MongoDB |
| afinidades-api | 4003 | Neo4j |
| frontend | 8080 | |

Quando um jogo é cadastrado, alterado ou excluído, o acervo-api chama o afinidades-api pra atualizar esse jogo no
grafo. Também tem a rota `POST /sync`, que apaga o grafo e monta de novo a partir de todos os jogos do acervo.

## PostgreSQL

- `jogadores`: o e-mail é `UNIQUE` e a senha é salva com hash bcrypt. No login a API devolve um token JWT, que é usado
  nas rotas de favoritos e histórico.
- `favoritos`: a chave primária é `(jogador_id, jogo_id)`, então o mesmo jogo não entra duas vezes. Se a conta for
  apagada os favoritos vão junto (`ON DELETE CASCADE`).
- `visualizacoes`: cada vez que alguém abre um jogo entra uma linha. O ranking é um `COUNT(*) ... GROUP BY jogo_id` e
  o histórico é a mesma tabela filtrada pelo jogador. Aqui usamos `ON DELETE SET NULL` pra que as visualizações de
  quem apagou a conta continuem contando no ranking.

## MongoDB

Cada jogo é um documento só, por exemplo:

```json
{
  "nome": "Catan",
  "categoria": "Família",
  "jogadores": { "min": 3, "max": 4 },
  "mecanicas": ["Rolagem de dados", "Negociação", "Construção de rotas"],
  "designers": ["Klaus Teuber"],
  "expansoes": [{ "nome": "Seafarers", "ano": 1997 }, { "nome": "Cities & Knights", "ano": 1998 }]
}
```

No relacional isso precisaria de tabelas separadas pra mecânicas, designers e expansões, e vários JOINs pra montar a
página do jogo.

## Neo4j

No grafo, jogos, mecânicas e designers são nós:

```
(:Jogo)-[:USA_MECANICA]->(:Mecanica)
(:Jogo)-[:CRIADO_POR]->(:Designer)
```

Os jogos parecidos são os que estão ligados às mesmas mecânicas ou designers do jogo aberto. A pontuação é o número de
mecânicas em comum mais 2 vezes o número de designers em comum (designer igual pesa mais):

```cypher
MATCH (origem:Jogo {id: $jogoId})-[:USA_MECANICA|CRIADO_POR]->(x)<-[:USA_MECANICA|CRIADO_POR]-(outro:Jogo)
WHERE outro <> origem
WITH outro, collect(DISTINCT x) AS comuns
WITH outro,
     [n IN comuns WHERE n:Mecanica | n.nome] AS mecanicas,
     [n IN comuns WHERE n:Designer | n.nome] AS designers
RETURN outro.nome, mecanicas, designers, size(mecanicas) + 2 * size(designers) AS pontuacao
ORDER BY pontuacao DESC LIMIT 5
```

No PostgreSQL isso seria um self-join com tabelas de junção e contagem. No grafo é só andar dois passos a partir do
jogo.

## Tuning

O que fizemos em cada banco pensando nas consultas que o sistema faz.

**PostgreSQL**

- Índice em `visualizacoes (jogo_id)` pro `GROUP BY` do ranking.
- Índice em `visualizacoes (jogador_id, visto_em DESC)` pro histórico, que filtra pelo jogador e ordena por data.
- `UNIQUE (email)` e a PK composta de `favoritos` deixam as regras no próprio banco, sem precisar de um `SELECT` antes
  do `INSERT` (usamos `ON CONFLICT DO NOTHING`).
- A rota `/estatisticas` faz as três contagens numa query só.

**MongoDB**

- Índice de texto `busca_textual` em português, com peso 10 pro nome, 5 pra mecânicas e designers, 3 pra tags e 1 pra
  descrição. O resultado vem ordenado pelo `textScore`.
- Índice `{ categoria: 1, criadoEm: -1 }` pro filtro de categoria, que já sai ordenado.
- Índice `{ 'jogadores.min': 1, 'jogadores.max': 1 }` pro filtro de número de jogadores.
- `GET /jogos?ids=a,b,c` busca vários jogos de uma vez com `$in`. O ranking, os favoritos e o histórico usam isso pra
  não fazer uma chamada por jogo (problema N+1).
- `.lean()` nas consultas de leitura.

**Neo4j**

- Constraints de unicidade em `Jogo.id`, `Mecanica.nome` e `Designer.nome`, que também criam índice pros
  `MERGE`/`MATCH`.
- O `/sync` usa `UNWIND` pra inserir tudo em poucas queries dentro de uma transação.
- Quando um jogo muda, só ele é atualizado no grafo (`PUT /grafo/jogos/:id`).

## Como rodar

O único programa necessário é o Docker. Não precisa instalar Node nem nenhum dos bancos, tudo roda em containers.

**1. Instalar o Docker Desktop**

- Baixar em https://www.docker.com/products/docker-desktop e instalar.
- No Windows, deixar marcada a opção "Use WSL 2" durante a instalação. Se pedir pra reiniciar o computador, reiniciar.
- Abrir o Docker Desktop e esperar aparecer "Engine running".

Os bancos e as APIs juntos usam uns 4 GB de memória.

**2. Baixar o projeto**

No GitHub, em **Code > Download ZIP**, e extrair. Ou com git:

```bash
git clone https://github.com/Herondsx/ludoteca-performance-e-tuning-de-dados.git
```

**3. Subir tudo**

Abrir um terminal (PowerShell no Windows) dentro da pasta do projeto, onde está o `docker-compose.yml`, e rodar:

```bash
docker compose up --build
```

A primeira vez demora alguns minutos porque baixa as imagens. Quando sobe pela primeira vez, o acervo cadastra 15 jogos
sozinho e monta o grafo no Neo4j, então não precisa fazer mais nada. O Neo4j é o mais lento pra subir, por isso o
afinidades-api pode reiniciar algumas vezes no começo até conseguir conectar.

**4. Abrir no navegador**

- Aplicação: http://localhost:8080
- Monitor dos bancos: http://localhost:8080/monitor.html
- Adminer: http://localhost:8082 (PostgreSQL, servidor `postgres`, usuário `ludoteca`, senha `ludoteca123`, base `ludoteca`)
- Mongo Express: http://localhost:8081
- Neo4j Browser: http://localhost:7474 (usuário `neo4j`, senha `ludoteca123`)

Pra parar é `Ctrl+C` no terminal ou `docker compose down`. Com `docker compose down -v` os dados são apagados e na
próxima vez os jogos são cadastrados de novo. Se quiser só voltar o acervo pros 15 jogos iniciais, com tudo rodando:

```bash
docker compose exec acervo-api npm run seed
```

Se der erro de porta em uso (8080, 8081, 8082, 4001 a 4003, 5432, 27017, 7474 ou 7687), dá pra trocar a porta da
esquerda no `docker-compose.yml`.

## Monitor dos bancos

Fizemos uma página separada (`monitor.html`) pra mostrar os três bancos funcionando. Ela consulta as APIs a cada 3
segundos e tem botões pra cadastrar um jogador de teste, cadastrar um jogo de teste, simular uma visualização e
reconstruir o grafo. Em "Explorar os dados" dá pra ver a tabela do PostgreSQL, o JSON de cada jogo no MongoDB e o grafo
de um jogo desenhado.

## Algumas consultas

Neo4j Browser:

```cypher
MATCH (j:Jogo)-[r]->(x) RETURN j, r, x
```

```cypher
MATCH (d:Designer {nome: 'Antoine Bauza'})<-[:CRIADO_POR]-(j:Jogo) RETURN d, j
```

```cypher
MATCH (m:Mecanica)<-[:USA_MECANICA]-(j:Jogo) RETURN m.nome, count(j) AS jogos ORDER BY jogos DESC
```

PostgreSQL (`docker compose exec postgres psql -U ludoteca -d ludoteca`):

```sql
EXPLAIN ANALYZE SELECT jogo_id, COUNT(*) FROM visualizacoes GROUP BY jogo_id ORDER BY 2 DESC LIMIT 10;
EXPLAIN ANALYZE SELECT jogo_id, MAX(visto_em) FROM visualizacoes WHERE jogador_id = 1 GROUP BY jogo_id;
```

Com poucos dados o PostgreSQL às vezes prefere Seq Scan mesmo tendo índice.

MongoDB (`docker compose exec mongodb mongosh ludoteca`):

```js
db.jogos.getIndexes()
db.jogos.find({ $text: { $search: 'cooperativo' } }).explain('executionStats').executionStats
```

## Endpoints

### jogadores-api (4001)

- `POST /cadastro` e `POST /login`: retornam o jogador e o token
- `GET /jogadores` e `GET /jogadores/:id`
- `PUT /jogadores/:id` e `DELETE /jogadores/:id`: precisa estar logado e ser a própria conta
- `POST /visualizacoes`
- `GET /ranking`
- `GET /favoritos`, `POST /favoritos/:jogoId` e `DELETE /favoritos/:jogoId`: precisa estar logado
- `GET /historico`: precisa estar logado
- `GET /estatisticas`
- `GET /saude`

As rotas que precisam de login usam o header `Authorization: Bearer <token>`.

### acervo-api (4002)

- `GET /jogos`: aceita os filtros `q`, `categoria`, `jogadores`, `limite` e `ids`
- `GET /jogos/:id`
- `POST /jogos`, `PUT /jogos/:id` e `DELETE /jogos/:id`
- `GET /estatisticas`
- `GET /saude`

### afinidades-api (4003)

- `GET /similares/:jogoId`: os 5 jogos mais parecidos
- `POST /mecanicas/:jogoId/:mecanica`, `GET /jogos/:jogoId/mecanicas`, `PUT /mecanicas/:antiga/:nova` e
  `DELETE /mecanicas/:jogoId/:mecanica`: CRUD das mecânicas no grafo
- `GET /mecanicas/populares`
- `GET /grafo/resumo`
- `PUT /grafo/jogos/:id` e `DELETE /grafo/jogos/:id`: usados pelo acervo-api
- `POST /sync`
- `GET /saude`
