// =============================================================================
// config.js — onde o navegador encontra cada API da Ludoteca
// -----------------------------------------------------------------------------
// Fica num arquivo separado de propósito: tanto o app (ludoteca.js) quanto o
// monitor (monitor.js) leem daqui, então se um dia a porta mudar a gente troca
// em UM lugar só. As portas são as que o docker compose publica no host.
//
// Repara que é "localhost" e não o nome do container (jogadores-api etc.):
// quem faz o fetch é o navegador da máquina de quem está assistindo, e ele não
// enxerga a rede interna do docker — só as portas publicadas.
// =============================================================================
window.LUDOTECA_API = {
  jogadores:  'http://localhost:4001', // PostgreSQL → contas, favoritos, histórico e ranking
  acervo:     'http://localhost:4002', // MongoDB    → catálogo de jogos (documentos)
  afinidades: 'http://localhost:4003'  // Neo4j      → grafo de mecânicas/designers (jogos parecidos)
};
