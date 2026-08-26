const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const admin = require('firebase-admin');
const mongoose = require('mongoose');
require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'suporte.gruposnj@gmail.com',
        pass: 'kwan ezft bxek ogeb'
    }
});

// URL do MongoDB Atlas (já com sua chave configurada)
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log('Conectado ao MongoDB Atlas com sucesso!'))
  .catch(err => console.error('Erro ao conectar no MongoDB:', err));

const GrupoSchema = new mongoose.Schema({
  id: Number,
  nome: String,
  link: String,
  categoria: String,
  descricao: String,
  imagem: String,
  email: String,
  autor: String,
  isVip: { type: Boolean, default: false },
  diasVip: { type: Number, default: 0 },
  acessos: { type: Number, default: 0 },
  data: { type: Date, default: Date.now },
  isParceiro: { type: Boolean, default: false },
  statusParceria: { type: String, enum: ['nenhum', 'pendente', 'aprovado'], default: 'nenhum' },
  usuarioDonoEmail: { type: String, default: '' }
});
const Grupo = mongoose.model('Grupo', GrupoSchema);

const SolicitacaoSchema = new mongoose.Schema({
  id: Number,
  nome: String,
  link: String,
  categoria: String,
  descricao: String,
  imagem: String,
  email: String,
  aceitouTermos: Boolean,
  data: { type: Date, default: Date.now }
});
const Solicitacao = mongoose.model('Solicitacao', SolicitacaoSchema);

// Schema unificado e definitivo do Usuário (sem duplicatas)
const UsuarioSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  nomeExibicao: String,
  foto: { type: String, default: '' },
  redeSocial: String
});
const Usuario = mongoose.model('Usuario', UsuarioSchema);

const DenunciaSchema = new mongoose.Schema({
  id: String,
  grupoId: String,
  nomeGrupo: String,
  motivo: String,
  usuarioEmail: String,
  data: { type: Date, default: Date.now }
});
const Denuncia = mongoose.model('Denuncia', DenunciaSchema);


const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// CONFIGURAÇÃO DO MERCADO PAGO
// ==========================================
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

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
function lerJson(filePath, defaultValue) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return defaultValue;
  }
}

function salvarJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getAdminPassword() {
  // Tenta pegar a senha do Render/dotenv (.env). Se não achar, tenta ler do config.json, e por fim usa "admin"
  if (process.env.ADMIN_PASSWORD) {
    return process.env.ADMIN_PASSWORD;
  }
  try {
    const config = lerJson(CONFIG_FILE, { adminPassword: "admin" });
    return config.adminPassword;
  } catch (e) {
    return "admin";
  }
}

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ==========================================
// ROTAS DO MERCADO PAGO (PIX AUTO-PROMOÇÃO)
// ==========================================
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

app.get('/api/pix/status/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;
    const response = await paymentClient.get({ id: paymentId });                                                                                          
    
    if (response.status === 'approved') {
      const grupoId = response.metadata?.grupo_id || (cobrancasPixMemoria[paymentId] && cobrancasPixMemoria[paymentId].grupoId);
      const dias = Number(response.metadata?.dias_vip || (cobrancasPixMemoria[paymentId] && cobrancasPixMemoria[paymentId].dias) || 7);

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
          console.log(`[STATUS PIX] VIP ativado com sucesso para o grupo ${grupoId} por ${dias} dias.`);
        }
      }
    }

    res.json({ status: response.status });
  } catch (error) {
    console.error('Erro ao consultar Pix:', error);
    res.status(500).json({ error: 'Erro ao consultar status no Mercado Pago.' });
  }
});

app.post('/api/webhook', async (req, res) => {
  try {
    const payment = req.body;

    if (payment.type === 'payment' || (payment.data && payment.id)) {
      const paymentId = payment.data ? payment.data.id : payment.id;
      const response = await paymentClient.get({ id: paymentId });

      if (response.status === 'approved') {
        const grupoId = response.metadata?.grupo_id || (cobrancasPixMemoria[paymentId] && cobrancasPixMemoria[paymentId].grupoId);
        const dias = Number(response.metadata?.vip_days || response.metadata?.dias_vip || (cobrancasPixMemoria[paymentId] && cobrancasPixMemoria[paymentId].dias) || 7);

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

app.get('/api/grupos/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const grupo = await Grupo.findOne({ id: isNaN(id) ? id : Number(id) });

    if (!grupo) {
      return res.status(404).json({ success: false, message: 'Grupo não encontrado' });
    }

    let grupoObj = grupo.toObject();

    // Mantém o autor original guardado para usar no link do perfil
    const autorOriginal = grupoObj.autor || 'Comunidade';

    let emailBusca = grupoObj.email || (grupoObj.autor && grupoObj.autor.includes('@') ? grupoObj.autor : null);

    let usuarioMatch = null;
    if (emailBusca) {
      usuarioMatch = await Usuario.findOne({ email: new RegExp(`^${emailBusca}$`, 'i') });
    }

    // Define o nome de exibição oficial
    if (usuarioMatch && usuarioMatch.nomeExibicao) {
      grupoObj.nomeExibicaoAutor = usuarioMatch.nomeExibicao;
    } else {
      if (autorOriginal.includes('@')) {
        grupoObj.nomeExibicaoAutor = autorOriginal.toLowerCase().includes('manoel153153') ? 'Ninja™' : autorOriginal.split('@')[0];
      } else {
        grupoObj.nomeExibicaoAutor = autorOriginal;
      }
    }

    // Garante que o .autor continua sendo o valor limpo/original para a URL do perfil
    grupoObj.autor = autorOriginal;

    res.json(grupoObj);
  } catch (error) {
    console.error("Erro na rota de detalhes:", error);
    res.status(500).json({ success: false, message: 'Erro no servidor' });
  }
});


app.post('/api/grupos/:id/acessar', async (req, res) => {
  try {
    const id = String(req.params.id);
    const grupo = await Grupo.findOne({ id: isNaN(id) ? id : Number(id) });

    if (grupo) {
      grupo.acessos = (grupo.acessos || 0) + 1;
      await grupo.save();
      return res.json({ success: true, acessos: grupo.acessos });
    }

    res.status(404).json({ success: false, error: 'Grupo não encontrado.' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erro ao registrar acesso.' });
  }
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

app.get('/api/grupos', async (req, res) => {
  try {
    let grupos = await Grupo.find();
    let usuarios = await Usuario.find();
    const agora = Date.now();

    for (let g of grupos) {
      if (g.isVip && g.vipAte && agora > g.vipAte) {
        g.isVip = false;
        await g.save();
      }

      // Expira a parceria automaticamente após 10 dias e libera a vaga
      if ((g.isParceiro || g.statusParceria === 'aprovado') && g.parceriaAte && agora > g.parceriaAte) {
        g.isParceiro = false;
        g.statusParceria = 'expirado';
        g.parceriaAte = null;
        await g.save();
      }

      if (g.email) {
        const usuarioMatch = usuarios.find(u => u.email && u.email.toLowerCase() === g.email.toLowerCase());
        if (usuarioMatch && usuarioMatch.nomeExibicao) {
          g.autor = usuarioMatch.nomeExibicao;
        } else if (g.email.toLowerCase().includes('manoel153153')) {
          g.autor = 'Ninja™'; // <--- Agora força com o símbolo certo!
        } else {
          g.autor = g.email.split('@')[0];
        }
      } else if (!g.autor) {
        g.autor = 'Membro';
      }

    }

    grupos.sort((a, b) => {
      // 1º: VIPs primeiro
      const vipDiff = (b.isVip ? 1 : 0) - (a.isVip ? 1 : 0);
      if (vipDiff !== 0) return vipDiff;

      // 2º: Parceiros aprovados logo depois dos VIPs
      const aParceiro = (a.isParceiro || a.statusParceria === 'aprovado') ? 1 : 0;
      const bParceiro = (b.isParceiro || b.statusParceria === 'aprovado') ? 1 : 0;
      const parceiroDiff = bParceiro - aParceiro;
      if (parceiroDiff !== 0) return parceiroDiff;

      // 3º: Desempate seguro por data de criação ou ID
      const dataA = new Date(a.createdAt || 0).getTime();
      const dataB = new Date(b.createdAt || 0).getTime();
      return dataB - dataA;
    });

    res.json(grupos);
  } catch (error) {
    console.error("Erro na rota /api/grupos:", error);
    res.status(500).json({ error: 'Erro ao buscar grupos' });
  }
});


app.post('/api/solicitar', async (req, res) => {
  try {
    const { nome, link, categoria, descricao, imagem, email, aceitouTermos } = req.body;

    if (!nome || !link) {
      return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
    }

    if (!aceitouTermos) {
      return res.status(400).json({ error: 'Você precisa aceitar os Termos de Uso para enviar o grupo.' });
    }

    const linkFormatado = link.trim().toLowerCase();

    const existeEmGrupos = await Grupo.findOne({ link: { $regex: new RegExp(`^${linkFormatado}$`, 'i') } });
    const existeEmSolicitacoes = await Solicitacao.findOne({ link: { $regex: new RegExp(`^${linkFormatado}$`, 'i') } });

    if (existeEmGrupos || existeEmSolicitacoes) {
      return res.status(400).json({ error: 'Este link de grupo já está cadastrado ou em análise no sistema!' });
    }

    await Solicitacao.create({
      id: Date.now(),
      nome,
      link: link.trim(),
      categoria: categoria || 'Geral',
      descricao: descricao || '',
      imagem: imagem || 'https://via.placeholder.com/100',
      email: email || 'Anonimo',
      aceitouTermos,
      data: new Date()
    });

    res.json({ success: true, mensagem: 'Grupo enviado para análise!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao processar solicitação' });
  }
});

// Rota para solicitar parceria (Envia para análise do admin)
app.post('/api/grupos/solicitar-parceria', async (req, res) => {
  try {
    const { grupoId, email } = req.body;
    
    if (!grupoId || !email) {
      return res.status(400).json({ error: 'Dados incompletos.' });
    }

    // Busca todos os grupos do usuário para verificar se ele já tem vaga ativa/pendente
    const gruposDoUsuario = await Grupo.find({ email: new RegExp(`^${email}$`, 'i') });
    
    const jaTemParceria = gruposDoUsuario.some(g => 
      String(g.id) !== String(grupoId) && 
      (g.statusParceria === 'aprovado' || g.statusParceria === 'pendente' || g.isParceiro) &&
      (!g.parceriaAte || Date.now() < g.parceriaAte)
    );

    if (jaTemParceria) {
      return res.status(400).json({ error: 'Você já possui uma vaga de parceria em uso ou pendente.' });
    }

    const numericId = isNaN(grupoId) ? grupoId : Number(grupoId);
    const grupo = await Grupo.findOne({ id: numericId });
    
    if (!grupo) {
      return res.status(404).json({ error: 'Grupo não encontrado.' });
    }

    // Define o status como pendente para o admin aprovar
    grupo.statusParceria = 'pendente';
    await grupo.save();

    res.json({ success: true, message: 'Solicitação enviada com sucesso! Aguarde a aprovação.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao processar solicitação de parceria.' });
  }
});

app.get('/api/estatisticas', async (req, res) => {
  try {
    const totalGrupos = await Grupo.countDocuments();
    const totalUsuarios = await Usuario.countDocuments();

    res.json({
      totalGrupos,
      totalUsuarios
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar estatísticas' });
  }
});

app.post('/api/atualizar-senha', express.json(), (req, res) => {
    const { senha } = req.body;
    res.json({ sucesso: true, mensagem: 'Senha alterada com sucesso!' });
});

// Rota para solicitar ou ativar a parceria do grupo (Validade: 10 dias)
app.post('/api/grupos/solicitar-parceria', async (req, res) => {
  try {
    const { grupoId, email } = req.body;

    if (!grupoId || !email) {
      return res.status(400).json({ error: 'Dados incompletos.' });
    }

    // Encontra o grupo que quer se tornar parceiro
    const grupo = await Grupo.findOne({ id: grupoId });
    if (!grupo) {
      return res.status(404).json({ error: 'Grupo não encontrado.' });
    }

    // TRAVA VIP: Impede grupos VIPs de solicitarem parceria
    if (grupo.isVip) {
      return res.status(400).json({ error: 'Grupos VIP possuem destaque máximo e não podem solicitar parceria.' });
    }

    // Busca todos os grupos do usuário para verificar se ele já tem 1 vaga ativa/pendente
    const gruposDoUsuario = await Grupo.find({ email: new RegExp(`^${email}$`, 'i') });

    const jaTemParceriaAtiva = gruposDoUsuario.some(g =>
      String(g.id) !== String(grupoId) &&
      (g.isParceiro || g.statusParceria === 'aprovado' || g.statusParceria === 'pendente') &&
      (!g.parceriaAte || Date.now() < g.parceriaAte)
    );

    if (jaTemParceriaAtiva) {
      return res.status(400).json({ error: 'Você já possui 1 vaga de parceria em uso (limite de 1 por usuário).' });
    }

    // Define a validade de 10 dias (10 dias * 24h * 60m * 60s * 1000ms)
    const dezDiasEmMs = 10 * 24 * 60 * 60 * 1000;

    grupo.isParceiro = true;
    grupo.statusParceria = 'aprovado'; // ou 'pendente' se preferir passar por moderação antes
    grupo.parceriaAte = Date.now() + dezDiasEmMs;

    await grupo.save();
                                                                                                                                           
    res.json({ success: true, message: 'Parceria ativada com sucesso por 10 dias!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao processar parceria.' });
  }
});

app.post('/api/cadastrar-grupo', async (req, res) => {
    try {
        const novoGrupo = req.body;

        // >>> AQUI JÁ É O SEU CÓDIGO ORIGINAL QUE SALVA NO BANCO (ex: Grupo.create ou new Grupo) <<<
        // (Deixe exatamente o comando do Mongoose que você já usa para salvar)
        await Grupo.create(novoGrupo); 

        // 🚨 SÓ ADICIONE ESTA LINHA AQUI LOGO DEPOIS DE SALVAR:
        await enviarAlertaNovoGrupo(novoGrupo);

        res.status(200).json({ success: true, message: 'Grupo cadastrado com sucesso!' });
    } catch (error) {
        console.error("Erro no cadastro:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// ==========================================
// ROTAS DE DENÚNCIAS
// ==========================================
app.post('/api/denunciar', async (req, res) => {
  try {
    const { grupoId, motivo, usuarioEmail } = req.body;

    if (!motivo || !usuarioEmail) {
      return res.status(400).json({ success: false, error: 'Preencha todos os campos obrigatórios.' });
    }

    let nomeGrupo = `ID: ${grupoId}`;

    try {
      const grupoEncontrado = await Grupo.findOne({ id: String(grupoId) });
      if (grupoEncontrado && grupoEncontrado.nome) {
        nomeGrupo = grupoEncontrado.nome;
      }
    } catch (err) {}

    const idDenuncia = 'den_' + Date.now() + Math.floor(Math.random() * 1000);

    await Denuncia.create({
      id: idDenuncia,
      grupoId: String(grupoId),
      nomeGrupo: nomeGrupo,
      motivo: motivo,
      usuarioEmail: usuarioEmail,
      data: new Date()
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('Erro ao salvar denúncia:', error);
    return res.status(500).json({ success: false, error: 'Erro interno ao processar a denúncia.' });
  }
});

app.get('/api/denuncias', async (req, res) => {
  try {
    const listaDenuncias = await Denuncia.find().sort({ data: -1 });
    res.json(listaDenuncias);
  } catch (error) {
    console.error('Erro ao buscar denúncias:', error);
    res.status(500).json({ error: 'Erro ao buscar denúncias.' });
  }
});

app.delete('/api/denuncias/:id', async (req, res) => {
  try {
    const target = decodeURIComponent(req.params.id).trim();

    const resultado = await Denuncia.deleteMany({
      $or: [
        { id: target },
        { grupoId: target }
      ]
    });

    if (resultado.deletedCount === 0) {
      return res.status(404).json({ success: false, error: 'Denúncia não encontrada.' });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Erro ao excluir denúncia:', error);
    return res.status(500).json({ success: false, error: 'Erro interno ao excluir denúncia.' });
  }
});

// ==========================================
// ROTAS DO PAINEL DO USUÁRIO
// ==========================================
app.get('/api/meus-grupos', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.json([]);

    const meusAtivos = await Grupo.find({ email: email });
    const solicitacoes = await Solicitacao.find({ email: email });

    const minhasSolicitacoes = solicitacoes.map(s => {
      const obj = s.toObject();
      return { ...obj, status: 'analise', emAnalise: true };
    });

    const todosOsMeusGrupos = [...meusAtivos, ...minhasSolicitacoes];

    res.json(todosOsMeusGrupos);
  } catch (error) {
    console.error('Erro ao buscar meus grupos:', error);
    res.status(500).json({ error: 'Erro interno ao buscar grupos.' });
  }
});

app.put('/api/meus-grupos/link', async (req, res) => {
  try {
    const { grupoId, email, novoLink } = req.body;
    if (!email || !grupoId || !novoLink) return res.status(400).json({ error: 'Dados incompletos.' });

    const linkFormatado = novoLink.trim().toLowerCase();

    const duplicadoGrupo = await Grupo.findOne({
      id: { $ne: String(grupoId) },
      link: { $regex: new RegExp(`^${linkFormatado}$`, 'i') }
    });

    const duplicadoSolicitacao = await Solicitacao.findOne({
      link: { $regex: new RegExp(`^${linkFormatado}$`, 'i') }
    });

    if (duplicadoGrupo || duplicadoSolicitacao) {
      return res.status(400).json({ error: 'Este link já está cadastrado em outro grupo!' });
    }

    // Busca o grupo para garantir que ele existe e pertence ao usuário
    let query = { id: String(grupoId), email: email };
    let grupo = await Grupo.findOne(query);

    if (!grupo && !isNaN(grupoId)) {
      // Tenta buscar com ID numérico caso o banco armazene como número
      query = { id: Number(grupoId), email: email };
      grupo = await Grupo.findOne(query);
    }

    if (!grupo) {
      return res.status(404).json({ error: 'Grupo não encontrado ou sem permissão.' });
    }

    // Atualiza diretamente no banco usando updateOne para evitar erro de validação do schema
    await Grupo.updateOne(
      { _id: grupo._id },
      { $set: { link: novoLink.trim() } }
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('Erro ao atualizar link:', error);
    res.status(500).json({ error: 'Erro interno ao atualizar link.' });
  }
});

app.delete('/api/meus-grupos/:id', async (req, res) => {
  try {
    const email = req.body.email;
    const idParaDeletar = String(req.params.id);

    if (!email) return res.status(400).json({ error: 'E-mail não fornecido.' });

    const resultado = await Grupo.deleteOne({ id: idParaDeletar, email: email });

    if (resultado.deletedCount > 0) {
      return res.json({ success: true });
    }

    res.status(404).json({ error: 'Grupo não encontrado ou você não é o dono.' });
  } catch (error) {
    console.error('Erro ao deletar grupo:', error);
    res.status(500).json({ error: 'Erro interno ao excluir grupo.' });
  }
});

// Rota GET para carregar o perfil do usuário (por nome ou email)
app.get('/api/usuario/perfil', async (req, res) => {
  try {
    const { email, nome } = req.query;
    const termoBusca = nome || email;

    if (!termoBusca || typeof termoBusca !== 'string' || termoBusca.trim() === '') {
      return res.status(400).json({ success: false, message: "Nome ou e-mail inválido ou não fornecido." });
    }

    // Procura o usuário pelo email, pelo nome de exibição ou pelo identificador correspondente
    const usuario = await Usuario.findOne({
      $or: [
        { email: new RegExp(`^${termoBusca.trim()}$`, 'i') },
        { nomeExibicao: new RegExp(`^${termoBusca.trim()}$`, 'i') },
        // Se você salvar o nome de usuário em outro campo no schema (ex: username), adicione aqui:
        // { username: new RegExp(`^${termoBusca.trim()}$`, 'i') }
      ]
    });

    if (!usuario) {
      return res.status(404).json({ success: false, message: "Usuário não encontrado." });
    }

    res.json({ success: true, usuario });
  } catch (err) {
    console.error("ERRO NO GET PERFIL:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Rota POST para salvar/atualizar o avatar do usuário
app.post('/api/usuario/perfil', async (req, res) => {
  try {
    const { email, foto, nomeExibicao } = req.body;

    if (!email || typeof email !== 'string' || email.trim() === '' || !email.includes('@') || email.toLowerCase() === 'null') {
      console.log("BLOQUEADO: E-mail inválido ->", email);
      return res.status(400).json({ success: false, message: "E-mail inválido ou não fornecido." });
    }

    let atualizacao = {};
    if (foto !== undefined) atualizacao.foto = foto;
    if (nomeExibicao !== undefined) atualizacao.nomeExibicao = nomeExibicao;

    const usuarioAtualizado = await Usuario.findOneAndUpdate(
      { email: new RegExp(`^${email.trim()}$`, 'i') },
      { $set: atualizacao },
      { upsert: true, new: true }
    );

    console.log("SUCESSO: Perfil atualizado para o e-mail:", email.trim());
    res.json({ success: true, message: "Perfil atualizado com sucesso!", usuario: usuarioAtualizado });
  } catch (err) {
    console.error("ERRO NO POST PERFIL:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// yROTAS DO PAINEL ADMINISTRATIVO
// ==========================================
app.post('/api/login', (req, res) => {
  const { senha } = req.body;
  if (senha === getAdminPassword()) return res.json({ success: true });
  res.status(401).json({ error: 'Senha incorreta' });
});

app.get('/api/admin/solicitacoes', async (req, res) => {
  try {
    const data = await Solicitacao.find().sort({ data: -1 });
    res.json(data);
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/admin/grupos', async (req, res) => {
  try {
    const data = await Grupo.find().sort({ data: -1 });
    res.json(data);
  } catch (err) {
    res.json([]);
  }
});

app.post('/api/admin/decidir-solicitacao', async (req, res) => {
  try {
    const { senha, id, aceito } = req.body;
    if (senha !== getAdminPassword()) return res.status(403).json({ error: 'Não autorizado' });

    const numericId = isNaN(id) ? id : Number(id);
    const item = await Solicitacao.findOne({ id: numericId });

    await Solicitacao.deleteOne({ id: numericId });

    if (aceito && item) {
      let usuarios = await Usuario.find();
      let usuarioPerfil = usuarios.find(u => u.email === item.email || String(u.email).replace(/[@.]/g, '') === String(item.email).replace(/[@.]/g, ''));

      let nomeAutor = 'Membro / Comunidade';
      if (usuarioPerfil && usuarioPerfil.nomeExibicao) {
        nomeAutor = usuarioPerfil.nomeExibicao;
      } else if (String(item.email).includes('manoel153153')) {
        nomeAutor = 'Ninja';
      } else if (item.email) {
        nomeAutor = item.email.split('@')[0];
      }

      await Grupo.create({
        id: Date.now(),
        nome: item.nome,
        categoria: item.categoria || 'Geral',
        link: item.link,
        descricao: item.descricao || '',
        imagem: item.imagem || 'https://via.placeholder.com/100',
        membros: '100+',
        email: item.email || '',
        autor: nomeAutor,
        isVip: false,
        acessos: 0
      });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao processar solicitação' });
  }
});

app.post('/api/admin/ativar-vip', async (req, res) => {
  try {
    const { senha, grupoId, dias } = req.body;
    if (senha !== getAdminPassword()) {
      return res.status(403).json({ error: 'Não autorizado' });
    }

    // Calcula a data de expiração do VIP somando os dias escolhidos
    const diasNum = parseInt(dias) || 30;
    const vipAte = new Date();
    vipAte.setDate(vipAte.getDate() + diasNum);

    // Tenta encontrar o grupo pelo ID personalizado ou _id do Mongo
    let query = { id: grupoId };
    if (!isNaN(grupoId)) {
      query = { $or: [{ id: grupoId }, { id: Number(grupoId) }] };
    }

    let grupo = await Grupo.findOne(query);
    if (!grupo && !isNaN(grupoId)) {
      try {
        grupo = await Grupo.findById(grupoId);
      } catch (e) {}
    }

    if (!grupo) {
      return res.status(404).json({ error: 'Grupo não encontrado' });
    }

    // Atualiza diretamente no banco usando updateOne para evitar erro de validação do schema
    await Grupo.updateOne(
      { _id: grupo._id },
      { $set: { isVip: true, vipAte: vipAte } }
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('ERRO DETALHADO NO ATIVAR VIP:', error);
    res.status(500).json({ error: 'Erro no servidor: ' + error.message });
  }
});

app.post('/api/admin/remover-vip', async (req, res) => {
  try {
    const { senha, grupoId } = req.body;
    if (senha !== getAdminPassword()) {
      return res.status(403).json({ error: 'Não autorizado' });
    }

    // Tenta encontrar o grupo pelo 'id' personalizado ou '_id'
    let query = { id: grupoId };
    if (!isNaN(grupoId)) {
      // Se for número, busca tanto como string quanto como número para garantir
      query = { $or: [{ id: grupoId }, { id: Number(grupoId) }] };
    }

    let grupo = await Grupo.findOne(query);
    if (!grupo && !isNaN(grupoId)) {
      try {
        grupo = await Grupo.findById(grupoId);
      } catch (e) {}
    }

    if (!grupo) {
      return res.status(404).json({ error: 'Grupo não encontrado' });
    }

    // Atualiza diretamente no banco usando updateOne para evitar erro de validação do schema em outros campos
    await Grupo.updateOne(
      { _id: grupo._id },
      { $set: { isVip: false, vipAte: null } }
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('ERRO DETALHADO NO REMOVER VIP:', error);
    res.status(500).json({ error: 'Erro no servidor: ' + error.message });
  }
});

app.post('/api/admin/aprovar-parceria/:id', async (req, res) => {
  try {
    const { senha } = req.body;
    if (senha !== getAdminPassword()) return res.status(403).json({ error: 'Não autorizado' });

    const grupoId = req.params.id;
    const numericId = isNaN(grupoId) ? grupoId : Number(grupoId);
    const grupo = await Grupo.findOne({ id: numericId });

    if (!grupo) return res.status(404).json({ error: 'Grupo não encontrado.' });

    const dezDiasEmMs = 10 * 24 * 60 * 60 * 1000;
    const dataExpiracao = Date.now() + dezDiasEmMs;

    grupo.isParceiro = true;
    grupo.statusParceria = 'aprovado';
    grupo.parceriaAte = dataExpiracao;
    grupo.validadeparceria = dataExpiracao; // Garante compatibilidade se o front usar esse nome

    await grupo.save();
    res.json({ success: true, message: 'Parceria aprovada com sucesso!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao aprovar parceria.' });
  }
});

// Rota para o ADM listar todos os grupos que são parceiros ativos
app.get('/api/adm/parceiros', async (req, res) => {
  try {
    const parceiros = await Grupo.find({ 
      $or: [{ statusParceria: 'aprovado' }, { isParceiro: true }] 
    });
    res.json(parceiros);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao buscar parceiros' });
  }
});

app.post('/api/adm/remover-parceria', async (req, res) => {
  try {
    const { grupoId } = req.body;
    if (!grupoId) {
      return res.status(400).json({ error: 'ID do grupo não fornecido.' });
    }

    let grupo = null;

    // Tenta atualizar pelo _id do MongoDB se tiver o tamanho correto (24 caracteres)
    if (grupoId.length === 24) {
      grupo = await Grupo.findByIdAndUpdate(grupoId, {
        $set: {
          statusParceria: 'removido',
          isParceiro: false,
          parceriaAte: null,
          validadeparceria: null
        }
      });
    }

    // Se não achou por _id, tenta buscar pelo campo customizado "id" ou ObjectId como string
    if (!grupo) {
      grupo = await Grupo.findOneAndUpdate(
        { $or: [{ id: grupoId }, { _id: grupoId.length === 24 ? grupoId : null }] },
        {
          $set: {
            statusParceria: 'removido',
            isParceiro: false,
            parceriaAte: null,
            validadeparceria: null
          }
        }
      );
    }

    if (!grupo) {
      return res.status(404).json({ error: 'Grupo não encontrado no banco de dados.' });
    }

    res.json({ success: true, message: 'Parceria removida com sucesso!' });
  } catch (error) {
    console.error("Erro ao remover parceria:", error);
    res.status(500).json({ error: 'Erro interno ao remover parceria.' });
  }
});

app.post('/api/admin/deletar-grupo/:id', async (req, res) => {
  try {
    const { senha } = req.body;
    if (senha !== getAdminPassword()) return res.status(403).json({ error: 'Não autorizado' });

    const idParaDeletar = req.params.id;
    const numericId = isNaN(idParaDeletar) ? idParaDeletar : Number(idParaDeletar);
    
    let resultado = await Grupo.deleteOne({ id: numericId });
    
    if (resultado.deletedCount === 0 && idParaDeletar.length === 24) {
      resultado = await Grupo.deleteOne({ _id: idParaDeletar });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao deletar grupo:', error);
    res.status(500).json({ error: 'Erro ao deletar grupo' });
  }
});

// Função para disparar o aviso de nova solicitação
async function enviarAlertaNovoGrupo(dadosGrupo) {
    const mailOptions = {
        from: 'suporte.gruposnj@gmail.com',
        to: 'suporte.gruposnj@gmail.com',
        subject: '🚨 Nova Solicitação de Grupo Registrada!',
        text: `Olá! Uma nova solicitação de grupo foi enviada no site.\n\nNome do Grupo: ${dadosGrupo.nome}\nLink: ${dadosGrupo.link}\n\nAcesse o painel para aprovar ou recusar!`
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('E-mail de notificação enviado com sucesso!');
    } catch (error) {
        console.error('Erro ao enviar e-mail de notificação:', error);
    }
}

// ==========================================
// INICIALIZAÇÃO DO SERVIDOR
// ==========================================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
