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

app.use(express.json());
app.use(express.static('public'));

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
  
  // Tenta achar pelo e-mail exato ou limpo
  let usuarioPerfil = usuarios.find(u => u.email === grupo.email || u.email.replace(/[@.]/g, '') === String(grupo.email).replace(/[@.]/g, ''));

  // Se não achou no array de usuários por e-mail, mas você quer forçar o seu nome Ninja caso seja o seu ID/email:
  if (!usuarioPerfil && String(grupo.email).includes('manoel153153')) {
    grupo.autor = 'Ninja';
  } else if (usuarioPerfil && usuarioPerfil.nomeExibicao) {
    grupo.autor = usuarioPerfil.nomeExibicao;
  } else if (!grupo.autor) {
    grupo.autor = grupo.email ? grupo.email.split('@')[0] : 'Membro / Comunidade';
  }

  res.json(grupo);
});


// Salvar ou atualizar o perfil do usuário
app.post('/api/usuario/perfil', (req, res) => {
  const { email, nomeExibicao } = req.body;
  if (!email || !nomeExibicao) {
    return res.status(400).json({ success: false, message: 'Dados incompletos.' });
  }

  let usuarios = lerJson(USERS_FILE, []);
  let usuario = usuarios.find(u => u.email === email);

  if (usuario) {
    usuario.nomeExibicao = nomeExibicao.trim();
  } else {
    usuarios.push({ email, nomeExibicao: nomeExibicao.trim() });
  }

  salvarJson(USERS_FILE, usuarios);
  res.json({ success: true, message: 'Perfil salvo com sucesso!' });
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
  const agora = Date.now();

  grupos = grupos.map(g => {
    if (g.isVip && g.vipAte && agora > g.vipAte) {
      g.isVip = false;
      g.vipAte = null;
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

const nodemailer = require('nodemailer');

// Configuração do Nodemailer com o seu e-mail e a senha de app gerada
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'suporte.gruposnj@gmail.com',
    pass: 'orsxijhslywsbhke' // Pode colocar com ou sem espaços
  }
});

app.post('/api/denunciar', async (req, res) => {
  try {
    const { grupoId, motivo, usuarioEmail } = req.body;

    if (!motivo || !usuarioEmail) {
      return res.status(400).json({ success: false, error: 'Preencha todos os campos obrigatórios.' });
    }

    let nomeGrupo = `ID: ${grupoId}`;

    // Tenta ler o arquivo onde ficam salvos os grupos (ajuste o nome do arquivo se necessário, ex: grupos.json, database.json)
    try {
      const caminhoArquivo = path.join(__dirname, 'grupos.json'); // Altere se o arquivo tiver outro nome/caminho
      if (fs.existsSync(caminhoArquivo)) {
        const dadosJson = JSON.parse(fs.readFileSync(caminhoArquivo, 'utf8'));
        
        // Procura o grupo pelo ID (pode ser array direto ou um objeto que guarda a lista)
        const listaGrupos = Array.isArray(dadosJson) ? dadosJson : (dadosJson.grupos || []);
        const grupoEncontrado = listaGrupos.find(g => String(g.id) === String(grupoId));
        
        if (grupoEncontrado && grupoEncontrado.nome) {
          nomeGrupo = grupoEncontrado.nome;
        }
      }
    } catch (err) {
      console.log('Erro ao ler o nome do grupo do arquivo:', err);
    }

    // Configuração do e-mail
    const mailOptions = {
      from: 'suporte.gruposnj@gmail.com',
      to: 'suporte.gruposnj@gmail.com',
      subject: `🚨 Nova Denúncia: ${nomeGrupo}`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background: #0f172a; color: #f1f5f9; border-radius: 8px;">
          <h2 style="color: #ef4444; margin-top: 0;">🚨 Nova Denúncia Registrada</h2>
          <p><strong>Nome do Grupo:</strong> <span style="color: #38bdf8;">${nomeGrupo}</span></p>
          <p><strong>ID do Grupo:</strong> ${grupoId}</p>
          <p><strong>E-mail de contato:</strong> ${usuarioEmail}</p>
          <p><strong>Motivo relatado:</strong></p>
          <div style="background: #1e293b; padding: 15px; border-left: 4px solid #ef4444; border-radius: 4px; color: #cbd5e1;">
            ${motivo}
          </div>
          <p style="font-size: 11px; color: #94a3b8; margin-top: 20px;">Enviado automaticamente pelo sistema GruposNJ.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    return res.json({ success: true });

  } catch (error) {
    console.error('Erro ao enviar e-mail de denúncia:', error);
    return res.status(500).json({ success: false, error: 'Erro interno ao processar a denúncia.' });
  }
});


// ==========================================
// ROTAS DO PAINEL DO USUÁRIO
// ==========================================

app.get('/api/meus-grupos', (req, res) => {
  const email = req.query.email;
  if (!email) return res.json([]);

  const grupos = lerJson(DATA_FILE, []);
  const meusGrupos = grupos.filter(g => g.email === email);
  res.json(meusGrupos);
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
  res.json(lerJson(SOLICITACOES_FILE, []));
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
      autor: nomeAutor, // <--- Agora a variável existe e vai funcionar perfeitamente!
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
