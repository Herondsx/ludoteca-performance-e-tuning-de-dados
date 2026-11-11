// seed.js — enche o acervo com 15 jogos de tabuleiro pra demonstração
//
// Como rodar (com os containers de pé):
//   docker compose exec acervo-api npm run seed
//
// O que ele faz, em ordem:
//   1. apaga TODOS os jogos da coleção (o seed é pra começar do zero)
//   2. insere os 15 jogos de uma vez com insertMany
//   3. confere os índices com syncIndexes
//   4. pede pro serviço de afinidades reconstruir o grafo no Neo4j
//
// Por que insertMany e não 15 saves? Porque o insertMany manda tudo num único
// comando pro Mongo (uma ida e volta na rede em vez de 15). Ele continua
// passando pela validação do schema, então dado torto não entra nem pelo seed.

const mongoose = require('mongoose');
const { Jogo } = require('./modelo');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/ludoteca';
// o seed roda DENTRO do container, então o padrão é o nome do serviço na rede
// do compose, e não localhost
const AFINIDADES_URL = (process.env.AFINIDADES_URL || 'http://afinidades-api:4003').replace(/\/+$/, '');

// imagem fica de fora de propósito: sem ela o frontend desenha uma capa
// com a cor e o emoji da categoria
const JOGOS = [
  {
    nome: 'Catan',
    categoria: 'Família',
    ano: 1995,
    editora: 'KOSMOS',
    designers: ['Klaus Teuber'],
    jogadores: { min: 3, max: 4 },
    duracaoMinutos: 90,
    idadeMinima: 10,
    complexidade: 2.3,
    mecanicas: ['Rolagem de dados', 'Negociação', 'Construção de rotas', 'Gestão de recursos', 'Tabuleiro modular'],
    expansoes: [{ nome: 'Seafarers', ano: 1997 }, { nome: 'Cities & Knights', ano: 1998 }],
    tags: ['clássico', 'porta de entrada', 'comércio'],
    descricao: 'Colonize a ilha de Catan coletando recursos, negociando com os outros jogadores e construindo estradas, aldeias e cidades. Um dos títulos que popularizaram os jogos de tabuleiro modernos.',
    comoJogar: 'No seu turno, role os dados: cada terreno com o número sorteado produz recursos para quem tem construções ao redor. Quando sai 7 ninguém produz, quem tem cartas demais perde metade e o ladrão é movido para bloquear um terreno e roubar uma carta de um adversário. Troque recursos com os outros jogadores ou com o banco e gaste-os em estradas, aldeias, cidades e cartas de desenvolvimento. Vence quem chegar primeiro a 10 pontos de vitória.'
  },
  {
    nome: 'Ticket to Ride',
    categoria: 'Família',
    ano: 2004,
    editora: 'Days of Wonder',
    designers: ['Alan R. Moon'],
    jogadores: { min: 2, max: 5 },
    duracaoMinutos: 45,
    idadeMinima: 8,
    complexidade: 1.8,
    mecanicas: ['Construção de rotas', 'Coleção de conjuntos', 'Draft', 'Objetivos secretos'],
    expansoes: [],
    tags: ['trens', 'viagem', 'porta de entrada'],
    descricao: 'Uma corrida ferroviária pelo mapa da América do Norte em que cada jogador tenta ligar cidades com seus vagõezinhos de plástico. As regras se explicam em poucos minutos, mas a briga pelos trechos mais disputados rende partidas bem tensas.',
    comoJogar: 'Na sua vez, faça apenas uma ação: comprar cartas de vagão, pegar novos bilhetes de destino ou ocupar uma rota entregando cartas da cor dela em quantidade igual ao número de espaços. Rotas longas valem bem mais pontos, e cada bilhete concluído soma pontos no fim — mas bilhete que ficou incompleto desconta. Quando alguém ficar com dois vagões ou menos, todos jogam mais uma vez e vence quem tiver mais pontos, contando o bônus do caminho contínuo mais longo.'
  },
  {
    nome: 'Carcassonne',
    categoria: 'Família',
    ano: 2000,
    editora: 'Hans im Glück',
    designers: ['Klaus-Jürgen Wrede'],
    jogadores: { min: 2, max: 5 },
    duracaoMinutos: 40,
    idadeMinima: 7,
    complexidade: 1.9,
    mecanicas: ['Colocação de peças', 'Controle de área', 'Tabuleiro modular'],
    expansoes: [{ nome: 'Inns & Cathedrals', ano: 2002 }, { nome: 'Traders & Builders', ano: 2003 }],
    tags: ['medieval', 'peças', 'rápido'],
    descricao: 'Os jogadores montam juntos, peça por peça, a paisagem ao redor da cidade medieval de Carcassonne, com estradas, cidades muradas, mosteiros e campos. Cada partida forma um mapa diferente, e o jogo virou uma das portas de entrada mais conhecidas do hobby.',
    comoJogar: 'No seu turno, compre uma peça de terreno e encaixe-a no mapa de forma que as bordas combinem com as vizinhas: estrada com estrada, cidade com cidade, campo com campo. Depois, se quiser, coloque um dos seus seguidores nessa peça para reivindicar uma estrada, cidade, mosteiro ou campo que ainda não tenha dono. Quando uma estrada, cidade ou mosteiro é concluído, quem domina aquela construção pontua na hora e recebe o seguidor de volta. Quando as peças acabam, construções incompletas e campos também pontuam, e vence quem somar mais.'
  },
  {
    nome: 'Pandemic',
    categoria: 'Cooperativo',
    ano: 2008,
    editora: 'Z-Man Games',
    designers: ['Matt Leacock'],
    jogadores: { min: 2, max: 4 },
    duracaoMinutos: 45,
    idadeMinima: 8,
    complexidade: 2.4,
    mecanicas: ['Cooperativo', 'Gestão de mão', 'Coleção de conjuntos', 'Poderes variáveis', 'Pontos de ação'],
    expansoes: [{ nome: 'On the Brink', ano: 2009 }],
    tags: ['cooperativo', 'doenças', 'tensão'],
    descricao: 'Quatro doenças se espalham pelo planeta e os jogadores, cada um com uma especialidade diferente, precisam trabalhar em equipe para descobrir as curas a tempo. Todos ganham ou todos perdem juntos, e a sensação de que tudo pode sair do controle a qualquer momento é o grande tempero do jogo.',
    comoJogar: 'No seu turno, gaste até 4 ações para viajar, tratar cidades infectadas, construir centros de pesquisa, trocar cartas com um colega ou descobrir uma cura entregando 5 cartas da mesma cor num centro de pesquisa. Em seguida compre 2 cartas do baralho de jogadores, onde estão escondidas as temidas Epidemias, e infecte novas cidades virando cartas do baralho de infecção. O grupo vence ao curar as 4 doenças e perde se acontecerem surtos demais, se faltarem cubos de alguma doença ou se o baralho de jogadores acabar.'
  },
  {
    nome: 'Azul',
    categoria: 'Abstrato',
    ano: 2017,
    editora: 'Plan B Games',
    designers: ['Michael Kiesling'],
    jogadores: { min: 2, max: 4 },
    duracaoMinutos: 40,
    idadeMinima: 8,
    complexidade: 1.8,
    mecanicas: ['Draft', 'Construção de padrões', 'Colocação de peças'],
    expansoes: [],
    tags: ['azulejos', 'abstrato', 'bonito'],
    descricao: 'Inspirado nos azulejos decorativos portugueses, Azul coloca os jogadores como artesãos disputando as peças mais bonitas para revestir a parede de um palácio. Tem regras curtas, peças gostosas de manusear e muita decisão sobre o que pegar e o que deixar sobrar para o adversário.',
    comoJogar: 'Na sua vez, pegue todos os azulejos de uma mesma cor de um dos mostruários (o que sobrar vai para o centro da mesa) ou todos os de uma cor que estejam no centro. Coloque-os numa das linhas de preparação do seu tabuleiro; o excesso cai na linha de chão e tira pontos. No fim da rodada, cada linha completa leva um azulejo para a parede, que pontua conforme os azulejos vizinhos já colocados. O jogo termina quando alguém completa uma linha horizontal da parede, com bônus finais por linhas, colunas e cores completas.'
  },
  {
    nome: '7 Wonders',
    categoria: 'Cartas',
    ano: 2010,
    editora: 'Repos Production',
    designers: ['Antoine Bauza'],
    jogadores: { min: 3, max: 7 },
    duracaoMinutos: 30,
    idadeMinima: 10,
    complexidade: 2.3,
    mecanicas: ['Draft', 'Coleção de conjuntos', 'Ações simultâneas', 'Construção de motor'],
    expansoes: [{ nome: 'Leaders', ano: 2011 }, { nome: 'Cities', ano: 2012 }],
    tags: ['civilização', 'muitos jogadores', 'rápido'],
    descricao: 'Cada jogador lidera uma civilização da Antiguidade e tenta fazê-la prosperar ao longo de três eras, erguendo construções e uma das maravilhas do mundo antigo. Funciona com até 7 pessoas sem a partida ficar mais longa, porque todo mundo joga ao mesmo tempo.',
    comoJogar: 'Em cada era, todos recebem uma mão de cartas, escolhem uma em segredo, revelam juntos e passam o restante para o vizinho. A carta escolhida pode ser construída pagando seu custo em recursos (comprando dos vizinhos o que faltar), usada para erguer uma etapa da sua maravilha ou descartada em troca de moedas. Ao fim de cada era há conflitos militares com os jogadores ao lado. Depois da terceira era somam-se os pontos de ciência, comércio, construções civis, guildas, maravilha, vitórias militares e moedas.'
  },
  {
    nome: 'Hanabi',
    categoria: 'Cooperativo',
    ano: 2010,
    editora: 'Les XII Singes',
    designers: ['Antoine Bauza'],
    jogadores: { min: 2, max: 5 },
    duracaoMinutos: 25,
    idadeMinima: 8,
    complexidade: 1.7,
    mecanicas: ['Cooperativo', 'Comunicação limitada', 'Dedução', 'Gestão de mão'],
    expansoes: [],
    tags: ['fogos de artifício', 'cooperativo', 'memória'],
    descricao: 'Os jogadores são pirotécnicos montando juntos um show de fogos de artifício, organizando cartas de cinco cores em sequência do 1 ao 5. A grande sacada é que cada um segura as próprias cartas viradas para fora: você enxerga a mão de todo mundo, menos a sua.',
    comoJogar: 'Na sua vez, escolha uma ação: dar uma dica a outro jogador apontando todas as cartas dele de uma cor ou de um número (gastando uma ficha de dica), descartar uma carta para recuperar uma ficha de dica, ou jogar uma carta na mesa. A carta jogada precisa continuar a sequência da cor dela; se não encaixar, o grupo perde uma ficha de pavio, e no terceiro erro o espetáculo acaba. Se isso não acontecer, a partida vai até o baralho terminar e a pontuação é a soma da carta mais alta de cada cor, no máximo 25 pontos.'
  },
  {
    nome: 'Takenoko',
    categoria: 'Família',
    ano: 2011,
    editora: 'Bombyx',
    designers: ['Antoine Bauza'],
    jogadores: { min: 2, max: 4 },
    duracaoMinutos: 45,
    idadeMinima: 8,
    complexidade: 1.9,
    mecanicas: ['Colocação de peças', 'Rolagem de dados', 'Objetivos secretos', 'Tabuleiro modular'],
    expansoes: [],
    tags: ['panda', 'bambu', 'jardim'],
    descricao: 'O imperador do Japão ganhou um panda gigante de presente e os jogadores, membros da corte, ficam encarregados de cuidar do jardim de bambu onde ele mora. É leve e cheio de charme, com bambus de encaixar que vão crescendo na mesa e um panda guloso que bagunça os planos de todo mundo.',
    comoJogar: 'A partir da segunda rodada, o turno começa com o dado de clima, que dá uma vantagem extra como uma ação a mais ou bambu crescendo. Depois faça duas ações diferentes entre: colocar uma nova parcela de terreno, pegar um canal de irrigação, mover o jardineiro (que faz o bambu crescer), mover o panda (que come um pedaço de bambu) ou comprar uma carta de objetivo. Os objetivos pedem formações de parcelas, bambus de certa altura ou combinações de bambu comidas pelo panda. Quem completar primeiro a quantidade de objetivos exigida ganha a carta do Imperador, os outros fazem um último turno e vence a maior pontuação.'
  },
  {
    nome: 'Dominion',
    categoria: 'Cartas',
    ano: 2008,
    editora: 'Rio Grande Games',
    designers: ['Donald X. Vaccarino'],
    jogadores: { min: 2, max: 4 },
    duracaoMinutos: 30,
    idadeMinima: 13,
    complexidade: 2.4,
    mecanicas: ['Construção de baralho', 'Gestão de mão'],
    expansoes: [{ nome: 'Intrigue', ano: 2009 }, { nome: 'Seaside', ano: 2009 }],
    tags: ['reinos', 'baralho', 'combos'],
    descricao: 'Pioneiro dos jogos de construção de baralho, Dominion coloca cada jogador como um monarca querendo expandir o próprio reino comprando cartas. Todos começam com o mesmo baralho fraquinho, e a graça está em lapidá-lo ao longo da partida até ele gerar combos poderosos.',
    comoJogar: 'O turno tem três fases: jogue uma carta de ação (ou mais, se alguma der ações extras), use seus tesouros para comprar uma carta da mesa e, por fim, descarte tudo e compre cinco cartas novas. As cartas compradas vão para o descarte e entram no baralho quando ele for reembaralhado, deixando-o cada vez mais forte. Cartas de vitória valem pontos mas não fazem nada durante o jogo, então o desafio é acertar o momento de começar a comprá-las. A partida termina quando acabam as Províncias ou quaisquer três pilhas da mesa, e vence quem tiver mais pontos de vitória.'
  },
  {
    nome: 'Agricola',
    categoria: 'Estratégia',
    ano: 2007,
    editora: 'Lookout Games',
    designers: ['Uwe Rosenberg'],
    jogadores: { min: 1, max: 5 },
    duracaoMinutos: 120,
    idadeMinima: 12,
    complexidade: 3.6,
    mecanicas: ['Alocação de trabalhadores', 'Gestão de recursos', 'Colocação de peças'],
    expansoes: [],
    tags: ['fazenda', 'pesado', 'euro'],
    descricao: 'Na Europa do século XVII, cada jogador comanda uma família de camponeses que precisa transformar um terreno pobre numa fazenda próspera. É um euro pesado e apertado: a comida sempre parece pouca e cada ação desperdiçada faz falta.',
    comoJogar: 'A cada rodada, os jogadores se alternam colocando os membros da família em espaços de ação para coletar materiais, arar, semear, cercar pastos, ampliar a casa, pegar animais ou ter filhos. Um espaço ocupado fica bloqueado para os outros naquela rodada, e ações novas vão sendo liberadas ao longo do jogo. Em algumas rodadas acontece a colheita, quando a família precisa ser alimentada, e quem não tiver comida suficiente recebe cartas de mendicância que tiram pontos. Depois de 14 rodadas, pontua-se a variedade da fazenda (campos, pastos, grãos, vegetais, animais, casa e família), com penalidade para cada espaço não aproveitado.'
  },
  {
    nome: 'Patchwork',
    categoria: 'Abstrato',
    ano: 2014,
    editora: 'Lookout Games',
    designers: ['Uwe Rosenberg'],
    jogadores: { min: 2, max: 2 },
    duracaoMinutos: 30,
    idadeMinima: 8,
    complexidade: 1.6,
    mecanicas: ['Colocação de peças', 'Gestão de recursos', 'Trilha de tempo'],
    expansoes: [],
    tags: ['dois jogadores', 'quebra-cabeça', 'colcha'],
    descricao: 'Um duelo para duas pessoas em que cada uma costura a sua colcha de retalhos, encaixando peças de formatos variados como num quebra-cabeça. Botões fazem o papel de dinheiro, e o tempo é um recurso tão valioso quanto eles.',
    comoJogar: 'Na sua vez, compre um dos três retalhos logo à frente do peão neutro pagando o custo em botões, avance seu marcador na trilha de tempo e encaixe o retalho no seu tabuleiro. Se preferir, avance o marcador até ficar logo à frente do adversário e ganhe um botão por casa andada. Joga sempre quem está mais atrás na trilha, então às vezes a mesma pessoa faz vários turnos seguidos, e ao cruzar os botões da trilha você recebe a renda dos retalhos já costurados. No fim, contam-se os botões e perdem-se 2 pontos por espaço vazio na colcha.'
  },
  {
    nome: 'Splendor',
    categoria: 'Família',
    ano: 2014,
    editora: 'Space Cowboys',
    designers: ['Marc André'],
    jogadores: { min: 2, max: 4 },
    duracaoMinutos: 30,
    idadeMinima: 10,
    complexidade: 1.8,
    mecanicas: ['Construção de motor', 'Coleção de conjuntos', 'Draft'],
    expansoes: [],
    tags: ['gemas', 'renascença', 'rápido'],
    descricao: 'Na pele de mercadores de pedras preciosas da Renascença, os jogadores investem em minas, rotas de transporte e lojas para atrair a visita de nobres. É rápido, tem regras enxutas e vicia por causa do motor de descontos que vai crescendo a cada compra.',
    comoJogar: 'Na sua vez, faça uma ação: pegar 3 fichas de gema de cores diferentes, pegar 2 da mesma cor (se a pilha tiver pelo menos 4), reservar uma carta levando uma ficha de ouro coringa, ou comprar uma carta pagando com fichas. Cada carta comprada vira um desconto permanente de uma gema nas próximas compras, e algumas também valem pontos de prestígio. Os nobres visitam sozinhos quem junta as cartas que eles exigem, rendendo pontos extras. Quando alguém chega a 15 pontos, a rodada é completada e vence quem tiver mais prestígio.'
  },
  {
    nome: 'Wingspan',
    categoria: 'Estratégia',
    ano: 2019,
    editora: 'Stonemaier Games',
    designers: ['Elizabeth Hargrave'],
    jogadores: { min: 1, max: 5 },
    duracaoMinutos: 60,
    idadeMinima: 10,
    complexidade: 2.4,
    mecanicas: ['Construção de motor', 'Gestão de mão', 'Rolagem de dados', 'Draft', 'Coleção de conjuntos'],
    expansoes: [{ nome: 'European Expansion', ano: 2019 }, { nome: 'Oceania Expansion', ano: 2020 }],
    tags: ['pássaros', 'natureza', 'cartas'],
    descricao: 'Os jogadores são apaixonados por aves tentando atrair as espécies mais interessantes para suas reservas naturais. Cada carta de pássaro traz ilustração caprichada e curiosidades reais da espécie, e os poderes delas se encadeiam em combinações cada vez mais produtivas.',
    comoJogar: 'Na sua vez, use um cubo de ação para fazer uma de quatro coisas: baixar um pássaro pagando comida (e ovos, dependendo da coluna), pegar comida no comedouro de dados, botar ovos ou comprar cartas de pássaro. As três últimas ativam um habitat (floresta, campo ou área úmida), e quanto mais pássaros houver naquela fileira mais forte fica a ação, já que os poderes marrons deles disparam em sequência. São 4 rodadas, cada uma com um cubo a menos e um objetivo de fim de rodada. No fim, somam-se os pontos dos pássaros, cartas de bônus, objetivos, ovos, comida guardada e cartas enfiadas sob os pássaros.'
  },
  {
    nome: 'Codenames',
    categoria: 'Party',
    ano: 2015,
    editora: 'Czech Games Edition',
    designers: ['Vlaada Chvátil'],
    jogadores: { min: 2, max: 8 },
    duracaoMinutos: 15,
    idadeMinima: 14,
    complexidade: 1.3,
    mecanicas: ['Jogo em equipes', 'Comunicação limitada', 'Dedução'],
    expansoes: [],
    tags: ['palavras', 'equipes', 'festa'],
    descricao: 'Dois times disputam quem encontra primeiro os próprios agentes secretos, escondidos numa grade de 25 palavras. Só o mestre-espião de cada time sabe quem é quem e precisa guiar os colegas usando dicas de uma palavra só.',
    comoJogar: 'Na vez do seu time, o mestre-espião dá uma dica formada por uma única palavra e um número, que indica quantas palavras da mesa têm a ver com ela. Os colegas apontam uma palavra de cada vez: se for um agente do próprio time, podem continuar tentando; se for um civil inocente ou um agente rival, a vez passa. Quem apontar o assassino perde a partida na hora, e vence o time que revelar todos os seus agentes primeiro.'
  },
  {
    nome: 'Dixit',
    categoria: 'Party',
    ano: 2008,
    editora: 'Libellud',
    designers: ['Jean-Louis Roubira'],
    jogadores: { min: 3, max: 6 },
    duracaoMinutos: 30,
    idadeMinima: 8,
    complexidade: 1.2,
    mecanicas: ['Narração', 'Votação', 'Gestão de mão'],
    expansoes: [],
    tags: ['imaginação', 'ilustrações', 'festa'],
    descricao: 'Um jogo de imaginação com cartas ilustradas cheias de cenas oníricas e surreais, em que ser sugestivo vale mais do que ser óbvio. Ótimo para reunir amigos e família, inclusive quem nunca jogou nada parecido.',
    comoJogar: 'A cada rodada, um jogador é o narrador: escolhe uma carta da mão e diz uma palavra, frase ou som inspirado nela. Os outros escolhem, da própria mão, a carta que melhor combina com a pista; tudo é embaralhado e revelado, e todos menos o narrador votam em qual seria a carta original. Se todo mundo ou ninguém acertar, o narrador fica sem pontos e os demais ganham 2; caso contrário, o narrador e quem acertou ganham 3, e os outros jogadores ainda levam 1 ponto por voto que a carta deles atraiu. A partida segue até o baralho acabar, e vence quem estiver mais à frente na trilha de pontos.'
  }
];

async function popular() {
  // mesma escolha da API: índices sob controle explícito (syncIndexes lá embaixo)
  await mongoose.connect(MONGO_URL, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
  console.log('[seed] conectado ao MongoDB');

  const removidos = await Jogo.deleteMany({});
  console.log(`[seed] ${removidos.deletedCount} jogo(s) antigo(s) apagado(s)`);

  // criadoEm decrescente: o primeiro da lista é o "mais novo". Como a listagem
  // ordena por criadoEm desc, a ordem da tela fica previsível (e igual à desta lista)
  const agora = Date.now();
  const documentos = JOGOS.map((jogo, i) => ({ ...jogo, criadoEm: new Date(agora - i * 60 * 1000) }));

  const inseridos = await Jogo.insertMany(documentos);
  console.log(`[seed] ${inseridos.length} jogos inseridos no acervo`);

  // garante os índices mesmo se o seed rodar antes da API ter subido alguma vez
  // (a API também faz isso ao iniciar, então normalmente aqui nada muda)
  await Jogo.syncIndexes();
  console.log('[seed] índices conferidos (busca_textual, categoria+criadoEm, faixa de jogadores)');
}

// avisa o serviço de afinidades pra reconstruir o grafo com os jogos novos.
// Se ele estiver fora do ar, o seed NÃO falha: o acervo já está populado e o
// grafo pode ser reconstruído à mão depois
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
    // sem banco não tem seed: aqui sim sai com erro
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
