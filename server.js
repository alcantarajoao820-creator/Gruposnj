const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// CONFIGURAÇÃO DO MERCADO PAGO
// ==========================================
const MP_ACCESS_TOKEN = 'APP_USR-1706102792295240-082021-c362fdf2543534d67bafaaf406826137-3629716031';

const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const paymentClient = new Payment(mpClient);

// Cache em memória para rastrear cobranças do Pix ativas
const cobrancasPixMemoria = {};

// ==========================================
// CONFIGURAÇÕES E CAMINHO DOS ARQUIVOS
// ==========================================
const DATA_FILE = path.join(__dirname, 'grupos.json');
const SOLICITACOES_FILE = path.join(__dirname, 'solicitacoes.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const USERS_FILE = path.join(__dirname, 'usuarios.json');
const DENUNCIAS_FILE = path.join(__dirname, 'denuncias.json');

app.use(express.json());
app.use(express.static('public'));
app.use(express.static(__dirname));

// ==========================================
// FUNÇÕES AUXILIARES DE LEITURA E ESCRITA
// ==========================================

function lerJson(file, defaultData = []) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultData, null, 2));
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) || defaultData;
  } catch (e) {
    return defaultData;
  }
}

function salvarJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getAdminPassword() {
  const config = lerJson(CONFIG_FILE, { adminPassword: "admin" });
  return config.adminPassword;
}

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ==========================================
// ROTAS DO MERCADO PAGO (PIX AUTO-PROMOÇÃO)
// ==========================================

// Função Rota: Gerar Cobrança Pix
app.post('/api/pix/gerar', async (req, res) => {
  try {
    const { grupoId, dias, valor } = req.body;

    if (!grupoId || !dias || !valor) {
      return res.status(400).json({ success: false, message: 'Dados incompletos para geração do Pix.' });
    }

    const body = {
      transaction_amount: Number(valor),
      description: `VIP GruposNJ - ${dias} dias (Grupo ID: ${grupoId})`,
      payment_method_id: 'pix',
      payer: {
        email: 'cliente@gruposnj.com',
      },
      metadata: {
        grupo_id: String(grupoId),
        dias_vip: Number(dias)
      }
    };

    const response = await paymentClient.create({ body });

    // Salva a relação no cache em memória
    cobrancasPixMemoria[response.id] = {
      grupoId: String(grupoId),
      dias: Number(dias),
      status: response.status
    };

    res.json({
      success: true,
      paymentId: response.id,
      qrCodeBase64: `data:image/png;base64,${response.point_of_interaction.transaction_data.qr_code_base64}`,
      pixCopiaECola: response.point_of_interaction.transaction_data.qr_code
    });

  } catch (error) {
    console.error('Erro ao gerar PIX com Mercado Pago:', error);
    res.status(500).json({ success: false, message: 'Erro ao conectar com Mercado Pago.' });
  }
});

// Função Rota: Checar Status do Pix e Ativar VIP Automaticamente
app.get('/api/pix/status/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;
    const response = await paymentClient.get({ id: paymentId });

    if (response.status === 'approved') {
      const grupoId = response.metadata.grupo_id || (cobrancasPixMemoria[paymentId] && cobrancasPixMemoria[paymentId].grupoId);
      const dias = Number(response.metadata.dias_vip || (cobrancasPixMemoria[paymentId] && cobrancasPixMemoria[paymentId].dias) || 7);

      if (grupoId) {
        let grupos = lerJson(DATA_FILE, []);
        const idx = grupos.findIndex(g => String(g.id) === String(grupoId));

        if (idx !== -1) {
          const tempoMs = dias * 24 * 60 * 60 * 1000;
          const agora = Date.now();

          const baseTempo = (grupos[idx].isVip && grupos[idx].vipAte && grupos[idx].vipAte > agora)
            ? grupos[idx].vipAte
            : agora;

          grupos[idx].isVip = true;
          grupos[idx].vipAte = baseTempo + tempoMs;

          salvarJson(DATA_FILE, grupos);
        }
      }
    }

    res.json({ status: response.status });
  } catch (error) {
    console.error('Erro ao consultar Pix:', error);
    res.status(500).json({ error: 'Erro ao consultar status no Mercado Pago.' });
  }
});

// Rota de Webhook para receber notificações automáticas do Mercado Pago
app.post('/api/webhook', async (req, res) => {
  try {
    const payment = req.body;

    // O Mercado Pago envia vários tipos de notificações, queremos apenas de pagamento
    if (payment.type === 'payment' || (payment.data && payment.id)) {
      const paymentId = payment.data ? payment.data.id : payment.id;
      
      // Consulta o pagamento na API do Mercado Pago para garantir que é real
      const response = await paymentClient.get({ id: paymentId });

      if (response.status === 'approved') {
        const grupoId = response.metadata.grupo_id || (cobrancasPixMemoria[paymentId] && cobrancasPixMemoria[paymentId].grupoId);
        const dias = Number(response.metadata.vip_days || response.metadata.dias_vip || (cobrancasPixMemoria[paymentId] && cobrancasPixMemoria[paymentId].dias) || 7);

        if (grupoId) {
          let grupos = lerJson(DATA_FILE, []);
          const idx = grupos.findIndex(g => String(g.id) === String(grupoId));

          if (idx !== -1) {
            const tempoMs = dias * 24 * 60 * 60 * 1000;
            const agora = Date.now();

            const baseTempo = (grupos[idx].isVip && grupos[idx].vipAte && grupos[idx].vipAte > agora)
              ? grupos[idx].vipAte
              : agora;

            grupos[idx].isVip = true;
            grupos[idx].vipAte = baseTempo + tempoMs;

            salvarJson(DATA_FILE, grupos);
            console.log(`[WEBHOOK] VIP ativado com sucesso para o grupo ${grupoId} por ${dias} dias.`);
          }
        }
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no Webhook:', error);
    res.status(500).send('Erro interno');
  }
});

// ==========================================
// ROTAS PÚBLICAS / UTILITÁRIAS
// ==========================================

app.get('/termos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'termos.html'));
});

app.get('/grupo/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'detalhes.html'));
});

app.get('/api/grupos/:id', (req, res) => {
  const id = String(req.params.id);
  const grupos = lerJson(DATA_FILE, []);
  const grupo = grupos.find(g => String(g.id) === id);

  if (!grupo) {
    return res.status(404).json({ success: false, message: 'Grupo não encontrado' });
  }

  let usuarios = lerJson(USERS_FILE, []);
  let usuarioPerfil = usuarios.find(u => u.email === grupo.email || u.email?.replace(/[@.]/g, '') === String(grupo.email).replace(/[@.]/g, ''));

  if (!usuarioPerfil && String(grupo.email).includes('manoel153153')) {
    grupo.autor = 'Ninja';
  } else if (usuarioPerfil && usuarioPerfil.nomeExibicao) {
    grupo.autor = usuarioPerfil.nomeExibicao;
  } else if (!grupo.autor) {
    grupo.autor = grupo.email ? grupo.email.split('@')[0] : 'Membro / Comunidade';
  }

  res.json(grupo);
});

app.post('/api/usuario/perfil', (req, res) => {
  const { email, nomeExibicao, redeSocial } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'E-mail obrigatório' });

  let usuarios = lerJson(USERS_FILE, []);
  let index = usuarios.findIndex(u => u.email && u.email.toLowerCase() === email.toLowerCase());

  // Força sempre a foto padrão única para todo mundo no servidor
  const fotoPadrao = "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=200&h=200&fit=crop";

  if (index >= 0) {
    if (nomeExibicao !== undefined) usuarios[index].nomeExibicao = nomeExibicao;
    if (redeSocial !== undefined) usuarios[index].redeSocial = redeSocial;
    usuarios[index].foto = fotoPadrao; // Trava a foto padrão aqui também
  } else {
    usuarios.push({ 
      email, 
      nomeExibicao: nomeExibicao || 'Ninja', 
      foto: fotoPadrao, 
      redeSocial: redeSocial || '' 
    });
  }

  fs.writeFileSync(USERS_FILE, JSON.stringify(usuarios, null, 2));
  res.json({ success: true });
});


app.post('/api/grupos/:id/acessar', (req, res) => {
  const id = String(req.params.id);
  let grupos = lerJson(DATA_FILE, []);
  const idx = grupos.findIndex(g => String(g.id) === id);

  if (idx !== -1) {
    grupos[idx].acessos = (grupos[idx].acessos || 0) + 1;
    salvarJson(DATA_FILE, grupos);
    return res.json({ success: true, acessos: grupos[idx].acessos });
  }

  res.status(404).json({ success: false, error: 'Grupo não encontrado.' });
});

app.get('/api/preview-link', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL necessária' });

  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 5000
    });
    const $ = cheerio.load(response.data);
    const title = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
    const image = $('meta[property="og:image"]').attr('content') || '';

    res.json({ title: title.trim(), image });
  } catch (e) {
    res.json({ title: '', image: '' });
  }
});

app.get('/api/grupos', (req, res) => {
  let grupos = lerJson(DATA_FILE, []);
  let usuarios = lerJson(USERS_FILE, []);
  const agora = Date.now();

  grupos = grupos.map(g => {
    if (g.isVip && g.vipAte && agora > g.vipAte) {
      g.isVip = false;
      g.vipAte = null;
    }

    // Padroniza o autor de cada grupo puxando o nome de exibição correto do usuário
    if (g.email) {
      const usuarioMatch = usuarios.find(u => u.email && u.email.toLowerCase() === g.email.toLowerCase());
      if (usuarioMatch && usuarioMatch.nomeExibicao) {
        g.autor = usuarioMatch.nomeExibicao;
      } else if (g.email.includes('manoel153153')) {
        g.autor = 'Ninja';
      } else {
        g.autor = g.email.split('@')[0];
      }
    } else if (!g.autor) {
      g.autor = 'Membro';
    }

    return g;
  });

  salvarJson(DATA_FILE, grupos);
  grupos.sort((a, b) => (b.isVip ? 1 : 0) - (a.isVip ? 1 : 0) || b.id - a.id);
  res.json(grupos);
});

app.post('/api/solicitar', (req, res) => {
  const { nome, link, categoria, descricao, imagem, email, aceitouTermos } = req.body;

  if (!nome || !link) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  }

  if (!aceitouTermos) {
    return res.status(400).json({ error: 'Você precisa aceitar os Termos de Uso para enviar o grupo.' });
  }

  const linkFormatado = link.trim().toLowerCase();
  const grupos = lerJson(DATA_FILE, []);
  const solicitacoes = lerJson(SOLICITACOES_FILE, []);

  const existeEmGrupos = grupos.some(g => g.link && g.link.trim().toLowerCase() === linkFormatado);
  const existeEmSolicitacoes = solicitacoes.some(s => s.link && s.link.trim().toLowerCase() === linkFormatado);

  if (existeEmGrupos || existeEmSolicitacoes) {
    return res.status(400).json({ error: 'Este link de grupo já está cadastrado ou em análise no sistema!' });
  }

  const novaSolicitacao = {
    id: Date.now(),
    nome,
    link: link.trim(),
    categoria: categoria || 'Geral',
    descricao: descricao || '',
    imagem: imagem || 'https://via.placeholder.com/100',
    email: email || 'Anonimo',
    data: new Date().toISOString()
  };

  solicitacoes.push(novaSolicitacao);
  salvarJson(SOLICITACOES_FILE, solicitacoes);

  res.json({ success: true, mensagem: 'Grupo enviado para análise!' });
});

// Rota para pegar as estatísticas do site
app.get('/api/estatisticas', (req, res) => {
  try {
    const grupos = lerJson(DATA_FILE, []); // Lê o arquivo grupos.json
    const usuarios = lerJson(USERS_FILE, []); // Lê o arquivo usuarios.json
    
    res.json({
      totalGrupos: grupos.length,
      totalUsuarios: usuarios.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar estatísticas' });
  }
});

// Função auxiliar para ler os favoritos de um usuário específico (por UID)
function lerFavoritosDoDisco(uid = 'anonimo') {
  try {
    // Cria uma pasta separada para favoritos se não existir, ou usa um nome de arquivo por usuário
    const arquivoUsuario = path.join(__dirname, `favoritos_${uid}.json`);
    
    if (!fs.existsSync(arquivoUsuario)) {
      fs.writeFileSync(arquivoUsuario, JSON.stringify({ favoritos: [] }, null, 2));
      return [];
    }
    const conteudo = fs.readFileSync(arquivoUsuario, 'utf8');
    const dados = JSON.parse(conteudo);
    return dados.favoritos || [];
  } catch (e) {
    console.error(`Erro ao ler favoritos do usuário ${uid}:`, e);
    return [];
  }
}

// Rota GET /api/favoritos (agora lê pelo ?uid=...)
app.get('/api/favoritos', (req, res) => {
  const uid = req.query.uid || 'anonimo';
  const lista = lerFavoritosDoDisco(uid);
  console.log(`Enviando favoritos para o usuário ${uid}:`, lista);
  res.json(lista);
});

// Rota POST /api/favoritos/alternar (agora salva no arquivo específico do uid)
app.post('/api/favoritos/alternar', express.json(), (req, res) => {
  try {
    const { grupoId, uid = 'anonimo' } = req.body;
    console.log(`Requisição para alternar favorito ID: ${grupoId} para o usuário: ${uid}`);

    if (!grupoId) return res.status(400).json({ erro: 'ID inválido' });

    const arquivoUsuario = path.join(__dirname, `favoritos_${uid}.json`);
    let favoritos = lerFavoritosDoDisco(uid);

    const index = favoritos.indexOf(grupoId);
    let status = '';

    if (index > -1) {
      favoritos.splice(index, 1);
      status = 'removido';
      console.log(`-> Removido dos favoritos do usuário ${uid}.`);
    } else {
      favoritos.push(grupoId);
      status = 'adicionado';
      console.log(`-> Adicionado aos favoritos do usuário ${uid}.`);
    }

    // Salva permanentemente no arquivo específico daquele usuário
    fs.writeFileSync(arquivoUsuario, JSON.stringify({ favoritos: favoritos }, null, 2), 'utf8');
    console.log(`-> Salvo com sucesso no arquivo do usuário ${uid}!`);

    res.json({ sucesso: true, status, favoritos: favoritos });
  } catch (e) {
    console.error("Erro ao salvar favorito:", e);
    res.status(500).json({ erro: 'Erro ao salvar favorito' });
  }
});

// Rota para Atualizar Senha
app.post('/api/atualizar-senha', express.json(), (req, res) => {
    const { senha } = req.body;
    // Lógica para salvar a nova senha
    res.json({ sucesso: true, mensagem: 'Senha alterada com sucesso!' });
});

// Salva a rede social, foto e nome de exibição de uma vez só
app.post('/api/usuario/perfil', (req, res) => {
  const { email, nomeExibicao, foto, redeSocial } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'E-mail obrigatório' });

  let usuarios = lerJson(USERS_FILE, []);
  let index = usuarios.findIndex(u => u.email && u.email.toLowerCase() === email.toLowerCase());

  if (index >= 0) {
    if (nomeExibicao !== undefined) usuarios[index].nomeExibicao = nomeExibicao;
    if (foto !== undefined) usuarios[index].foto = foto;
    if (redeSocial !== undefined) usuarios[index].redeSocial = redeSocial;
  } else {
    usuarios.push({ email, nomeExibicao: nomeExibicao || 'Ninja', foto: foto || '', redeSocial: redeSocial || '' });
  }

  fs.writeFileSync(USERS_FILE, JSON.stringify(usuarios, null, 2));
  res.json({ success: true, message: 'Dados salvos com sucesso!' });
});

// Retorna os dados do usuário para a página de perfil
app.get('/api/usuario/perfil', (req, res) => {
  const { email, nome } = req.query;
  let usuarios = lerJson(USERS_FILE, []);
  let usuario = usuarios.find(u =>
    (email && u.email && u.email.toLowerCase() === String(email).toLowerCase()) ||
    (nome && u.nomeExibicao && u.nomeExibicao.toLowerCase() === decodeURIComponent(nome).toLowerCase())
  );

  // Se não encontrar o usuário cadastrado, cria um perfil dinâmico com o nome que veio na URL (sem forçar o Ninja)
  if (!usuario) {
    const nomeDecodificado = nome ? decodeURIComponent(nome) : 'Membro';
    usuario = {
      nomeExibicao: nomeDecodificado,
      foto: '',
      redeSocial: ''
    };
  }

  res.json({ success: true, usuario });
});

// ==========================================
// ROTAS DE DENÚNCIAS
// ==========================================

// Rota para registrar denúncia (Garante que o ID seja sempre gerado)
app.post('/api/denunciar', async (req, res) => {
  try {
    const { grupoId, motivo, usuarioEmail } = req.body;

    if (!motivo || !usuarioEmail) {
      return res.status(400).json({ success: false, error: 'Preencha todos os campos obrigatórios.' });
    }

    let nomeGrupo = `ID: ${grupoId}`;

    try {
      if (fs.existsSync(DATA_FILE)) {
        const grupos = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const grupoEncontrado = grupos.find(g => String(g.id) === String(grupoId));
        if (grupoEncontrado && grupoEncontrado.nome) {
          nomeGrupo = grupoEncontrado.nome;
        }
      }
    } catch (err) {}

    const denuncias = lerJson(DENUNCIAS_FILE, []);
    
    // Geramos um ID único garantido usando timestamp + número aleatório
    const novaDenuncia = {
      id: 'den_' + Date.now() + Math.floor(Math.random() * 1000),
      grupoId: String(grupoId),
      nomeGrupo: nomeGrupo,
      motivo: motivo,
      usuarioEmail: usuarioEmail,
      data: new Date().toISOString()
    };

    denuncias.unshift(novaDenuncia);
    salvarJson(DENUNCIAS_FILE, denuncias);

    return res.json({ success: true });
  } catch (error) {
    console.error('Erro ao salvar denúncia:', error);
    return res.status(500).json({ success: false, error: 'Erro interno ao processar a denúncia.' });
  }
});

// Rota para listar denúncias
app.get('/api/denuncias', async (req, res) => {
  try {
    const denuncias = lerJson(DENUNCIAS_FILE, []);
    return res.json({ success: true, denuncias });
  } catch (error) {
    console.error('Erro ao buscar denúncias:', error);
    return res.status(500).json({ success: false, error: 'Erro ao carregar denúncias.' });
  }
});

app.delete('/api/denuncias/:id', (req, res) => {
  try {
    const target = decodeURIComponent(req.params.id).trim();
    let denuncias = lerJson(DENUNCIAS_FILE, []);

    console.log('--- TENTANDO EXCLUIR ---');
    console.log('Alvo recebido da URL:', target);
    console.log('IDs disponíveis no JSON:', denuncias.map(d => ({ id: d.id, grupoId: d.grupoId })));

    const tamanhoInicial = denuncias.length;

    // Filtra mantendo apenas os que NÃO batem nem com o id único nem com o grupoId
    denuncias = denuncias.filter(d => {
      const matchId = String(d.id || '').trim() === target;
      const matchGrupo = String(d.grupoId || '').trim() === target;
      return !matchId && !matchGrupo; // Se for igual a qualquer um dos dois, remove
    });

    if (denuncias.length === tamanhoInicial) {
      console.log('❌ Nenhuma denúncia correspondente encontrada para remover.');
      return res.status(404).json({ success: false, error: 'Denúncia não encontrada.' });
    }

    salvarJson(DENUNCIAS_FILE, denuncias);
    console.log('✅ Denúncia apagada com sucesso! Restaram:', denuncias.length);
    return res.json({ success: true });
  } catch (error) {
    console.error('Erro ao excluir denúncia:', error);
    return res.status(500).json({ success: false, error: 'Erro interno ao excluir denúncia.' });
  }
});

// ==========================================
// ROTAS DO PAINEL DO USUÁRIO
// ==========================================

app.get('/api/meus-grupos', (req, res) => {
  const email = req.query.email;
  if (!email) return res.json([]);

  // Lê os grupos aprovados/ativos e também as solicitações pendentes (em análise)
  const gruposAtivos = lerJson(DATA_FILE, []);
  const solicitacoes = lerJson(SOLICITACOES_FILE, []);

  // Filtra os do usuário em ambas as listas
  const meusAtivos = gruposAtivos.filter(g => g.email === email);
  
  // Garante que o objeto venha com uma flag clara de que está em análise
  const minhasSolicitacoes = solicitacoes
    .filter(s => s.email === email)
    .map(s => ({ ...s, status: 'analise', emAnalise: true }));

  // Junta tudo em um único array para o painel exibir
  const todosOsMeusGrupos = [...meusAtivos, ...minhasSolicitacoes];

  res.json(todosOsMeusGrupos);
});

app.put('/api/meus-grupos/link', (req, res) => {
  const { grupoId, email, novoLink } = req.body;
  if (!email || !grupoId || !novoLink) return res.status(400).json({ error: 'Dados incompletos.' });

  const linkFormatado = novoLink.trim().toLowerCase();
  let grupos = lerJson(DATA_FILE, []);
  let solicitacoes = lerJson(SOLICITACOES_FILE, []);

  const duplicadoGrupo = grupos.some(g => String(g.id) !== String(grupoId) && g.link && g.link.trim().toLowerCase() === linkFormatado);
  const duplicadoSolicitacao = solicitacoes.some(s => s.link && s.link.trim().toLowerCase() === linkFormatado);

  if (duplicadoGrupo || duplicadoSolicitacao) {
    return res.status(400).json({ error: 'Este link já está cadastrado em outro grupo!' });
  }

  const idx = grupos.findIndex(g => String(g.id) === String(grupoId) && g.email === email);
  if (idx !== -1) {
    grupos[idx].link = novoLink.trim();
    salvarJson(DATA_FILE, grupos);
    return res.json({ success: true });
  }

  res.status(404).json({ error: 'Grupo não encontrado ou sem permissão.' });
});

app.delete('/api/meus-grupos/:id', (req, res) => {
  const email = req.body.email;
  const idParaDeletar = String(req.params.id);

  if (!email) return res.status(400).json({ error: 'E-mail não fornecido.' });

  let grupos = lerJson(DATA_FILE, []);
  const tamanhoOriginal = grupos.length;

  grupos = grupos.filter(g => !(String(g.id) === idParaDeletar && g.email === email));

  if (grupos.length < tamanhoOriginal) {
    salvarJson(DATA_FILE, grupos);
    return res.json({ success: true });
  }

  res.status(404).json({ error: 'Grupo não encontrado ou você não é o dono.' });
});

// ==========================================
// ROTAS DO PAINEL ADMINISTRATIVO
// ==========================================

app.post('/api/login', (req, res) => {
  const { senha } = req.body;
  if (senha === getAdminPassword()) return res.json({ success: true });
  res.status(401).json({ error: 'Senha incorreta' });
});

app.get('/api/admin/solicitacoes', (req, res) => {
  try {
    const fs = require('fs');
    if (!fs.existsSync('solicitacoes.json')) {
      fs.writeFileSync('solicitacoes.json', '[]');
    }
    const data = JSON.parse(fs.readFileSync('solicitacoes.json', 'utf8'));
    res.json(data);
  } catch (err) {
    res.json([]);
  }
});

// Rota para puxar todos os grupos cadastrados
app.get('/api/grupos', (req, res) => {
  try {
    const fs = require('fs');
    if (!fs.existsSync('grupos.json')) {
      fs.writeFileSync('grupos.json', '[]');
    }
    const data = JSON.parse(fs.readFileSync('grupos.json', 'utf8'));
    res.json(data);
  } catch (err) {
    res.json([]);
  }
});


app.post('/api/admin/decidir-solicitacao', (req, res) => {
  const { senha, id, aceito } = req.body;
  if (senha !== getAdminPassword()) return res.status(403).json({ error: 'Não autorizado' });

  let solicitacoes = lerJson(SOLICITACOES_FILE, []);
  const item = solicitacoes.find(s => String(s.id) === String(id));
  solicitacoes = solicitacoes.filter(s => String(s.id) !== String(id));
  salvarJson(SOLICITACOES_FILE, solicitacoes);

  if (aceito && item) {
    let grupos = lerJson(DATA_FILE, []);
    let usuarios = lerJson(USERS_FILE, []);

    // Procura o perfil do usuário para pegar o nome de exibição correto
    let usuarioPerfil = usuarios.find(u => u.email === item.email || String(u.email).replace(/[@.]/g, '') === String(item.email).replace(/[@.]/g, ''));

    let nomeAutor = 'Membro / Comunidade';
    if (usuarioPerfil && usuarioPerfil.nomeExibicao) {
      nomeAutor = usuarioPerfil.nomeExibicao;
    } else if (String(item.email).includes('manoel153153')) {
      nomeAutor = 'Ninja';
    } else if (item.email) {
      nomeAutor = item.email.split('@')[0];
    }

    grupos.push({
      id: Date.now(),
      nome: item.nome,
      categoria: item.categoria || 'Geral',
      link: item.link,
      descricao: item.descricao || '',
      imagem: item.imagem || 'https://via.placeholder.com/100',
      membros: '100+',
      email: item.email || '',
      autor: nomeAutor,
      isVip: false
    });

    salvarJson(DATA_FILE, grupos);
  }

  res.json({ success: true });
});


app.post('/api/admin/ativar-vip', (req, res) => {
  const { senha, grupoId, dias } = req.body;
  if (senha !== getAdminPassword()) return res.status(403).json({ error: 'Não autorizado' });

  let grupos = lerJson(DATA_FILE, []);
  const idx = grupos.findIndex(g => String(g.id) === String(grupoId));

  if (idx !== -1) {
    const tempoMs = (parseInt(dias) || 30) * 24 * 60 * 60 * 1000;
    grupos[idx].isVip = true;
    grupos[idx].vipAte = Date.now() + tempoMs;
    salvarJson(DATA_FILE, grupos);
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Grupo não encontrado' });
});

app.post('/api/admin/remover-vip', (req, res) => {
  const { senha, grupoId } = req.body;
  if (senha !== getAdminPassword()) return res.status(403).json({ error: 'Não autorizado' });

  let grupos = lerJson(DATA_FILE, []);
  const idx = grupos.findIndex(g => String(g.id) === String(grupoId));

  if (idx !== -1) {
    grupos[idx].isVip = false;
    grupos[idx].vipAte = null;
    salvarJson(DATA_FILE, grupos);
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Grupo não encontrado' });
});

app.delete('/api/grupos/:id', (req, res) => {
  const { senha } = req.body;
  if (senha !== getAdminPassword()) return res.status(403).json({ error: 'Não autorizado' });

  const idParaDeletar = String(req.params.id);
  let grupos = lerJson(DATA_FILE, []);
  grupos = grupos.filter(g => String(g.id) !== idParaDeletar);

  salvarJson(DATA_FILE, grupos);
  res.json({ success: true });
});

// ==========================================
// INICIALIZAÇÃO DO SERVIDOR
// ==========================================
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
