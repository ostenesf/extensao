// PJe TJPI – Baixar autos em lote (versão para o Mozilla Firefox)
// Orquestra, processo a processo, o mesmo caminho feito manualmente:
//   Consulta processos → preenche o número → Pesquisar → abre o processo →
//   botão "Download autos do processo" → DOWNLOAD → salva o PDF.
//
// Diferenças em relação à versão do Chrome:
//   * usa a API `browser.*` do Firefox (baseada em Promises);
//   * roda numa página de fundo persistente (Manifest V2), que o Firefox não
//     encerra no meio de uma execução longa;
//   * o relatório CSV é gerado aqui, e não no painel, porque o Firefox fecha
//     o painel (e invalida o arquivo temporário) quando o download começa.

const BASE = 'https://pje.tjpi.jus.br/1g';
const URL_CONSULTA = BASE + '/Processo/ConsultaProcesso/listView.seam';

let rodando = false;
let pararSolicitado = false;

// ---------------------------------------------------------------- estado ----
async function lerEstado() {
  const { estado } = await browser.storage.local.get('estado');
  return estado || { rodando: false, itens: [], log: [], opcoes: null };
}
async function gravarEstado(e) { await browser.storage.local.set({ estado: e }); }

// Toda alteração do estado passa por esta fila, uma de cada vez, para que um
// registro no log (ex.: "Parar") não sobrescreva a atualização de um item.
let filaEstado = Promise.resolve();
function alterarEstado(fn) {
  const tarefa = filaEstado.then(async () => { const e = await lerEstado(); await fn(e); await gravarEstado(e); return e; });
  filaEstado = tarefa.catch(() => {});
  return tarefa;
}

function registrar(msg) {
  return alterarEstado(e => {
    const hora = new Date().toLocaleTimeString('pt-BR');
    e.log.push(`[${hora}] ${msg}`);
    if (e.log.length > 400) e.log = e.log.slice(-400);
  });
}

function atualizarItem(numero, campos) {
  return alterarEstado(e => {
    const it = e.itens.find(i => i.numero === numero);
    if (it) Object.assign(it, campos, { atualizadoEm: new Date().toISOString() });
  });
}

// A página de fundo só é carregada quando o Firefox abre ou a extensão é
// (re)instalada; se havia execução marcada como "rodando", ela foi interrompida.
limparExecucaoInterrompida();
function limparExecucaoInterrompida() {
  return alterarEstado(e => {
    if (!e.rodando) return;
    e.rodando = false;
    e.itens.forEach(i => { if (i.status === 'processando') { i.status = 'interrompido'; i.detalhe = 'Execução interrompida (navegador/extensão reiniciado).'; } });
  });
}

// ------------------------------------------------------------- mensagens ----
// No Firefox, o ouvinte pode devolver uma Promise com a resposta.
browser.runtime.onMessage.addListener(msg => tratarMensagem(msg).catch(err => ({ ok: false, erro: err.message })));

async function tratarMensagem(msg) {
  if (msg.cmd === 'iniciar') {
    if (rodando) return { ok: false, erro: 'Já existe uma execução em andamento.' };
    rodando = true; // reserva já, para um segundo clique não iniciar outra execução
    pararSolicitado = false;
    try {
      await alterarEstado(e => {
        e.itens = msg.numeros.map(n => ({ numero: n, status: 'pendente', detalhe: '', arquivo: '' }));
        e.log = [];
        e.opcoes = msg.opcoes;
      });
    } catch (err) { rodando = false; throw err; }
    executar().catch(err => registrar('ERRO GERAL: ' + err.message));
    return { ok: true };
  }
  if (msg.cmd === 'retomar') {
    if (rodando) return { ok: false, erro: 'Já existe uma execução em andamento.' };
    const e = await lerEstado();
    if (!e.opcoes && !msg.opcoes) return { ok: false, erro: 'Não há execução anterior para retomar.' };
    rodando = true;
    pararSolicitado = false;
    try {
      await alterarEstado(est => {
        const alvo = msg.incluirErros ? ['pendente', 'interrompido', 'erro', 'nao_encontrado'] : ['pendente', 'interrompido'];
        est.itens.forEach(i => { if (alvo.includes(i.status)) { i.status = 'pendente'; i.detalhe = ''; } });
        if (msg.opcoes) est.opcoes = msg.opcoes;
      });
    } catch (err) { rodando = false; throw err; }
    executar().catch(err => registrar('ERRO GERAL: ' + err.message));
    return { ok: true };
  }
  if (msg.cmd === 'parar') {
    if (!rodando) return { ok: true };
    pararSolicitado = true;
    await registrar('Parada solicitada — encerro após o processo em andamento.');
    return { ok: true };
  }
  if (msg.cmd === 'limpar') {
    if (rodando) return { ok: false, erro: 'Pare a execução antes de limpar.' };
    await alterarEstado(e => { e.rodando = false; e.itens = []; e.log = []; e.opcoes = null; });
    return { ok: true };
  }
  if (msg.cmd === 'csv') {
    await exportarCsv(msg.rotulos || {}, msg.pasta || 'PJe-autos');
    return { ok: true };
  }
  return { ok: false, erro: 'Comando desconhecido' };
}

async function exportarCsv(rotulos, pasta) {
  const e = await lerEstado();
  const linhas = [['processo', 'situacao', 'arquivo', 'detalhe', 'atualizado_em']]
    .concat((e.itens || []).map(i => [i.numero, rotulos[i.status] || i.status, i.arquivo || '', i.detalhe || '', i.atualizadoEm || '']));
  const csv = '\ufeff' + linhas.map(l => l.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const carimbo = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  try {
    const id = await browser.downloads.download({ url, filename: `${pasta}/relatorio-${carimbo}.csv`, conflictAction: 'uniquify', saveAs: false });
    await aguardarDownload(id, 60000);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------- utilidades ----
const esperar = ms => new Promise(r => setTimeout(r, ms));

async function rodarNaPagina(tabId, func, args = []) {
  // world 'MAIN': roda no próprio contexto do PJe (necessário para interceptar o
  // window.open da página). Suportado pelo Firefox 128 ou superior.
  const [res] = await browser.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  if (res && res.error) throw new Error(String(res.error.message || res.error));
  return res ? res.result : undefined;
}

// Repete `func` na página até devolver algo diferente de null/undefined, ou estourar o tempo.
async function aguardarNaPagina(tabId, func, args, timeoutMs, intervaloMs = 700) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await rodarNaPagina(tabId, func, args);
      if (r !== null && r !== undefined) return r;
    } catch (_) { /* página ainda carregando/navegando */ }
    await esperar(intervaloMs);
  }
  return null;
}

async function aguardarCarregamento(tabId, testeUrl, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === 'complete' && (!testeUrl || testeUrl.test(tab.url || ''))) return tab;
    await esperar(500);
  }
  const tab = await browser.tabs.get(tabId);
  return (!testeUrl || testeUrl.test(tab.url || '')) ? tab : null;
}

async function navegar(tabId, url) {
  await browser.tabs.update(tabId, { url });
  await esperar(800);
  return aguardarCarregamento(tabId, null, 45000);
}

async function aguardarDownload(id, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const [d] = await browser.downloads.search({ id });
    if (d && d.state === 'complete') return d;
    if (d && d.state === 'interrupted') throw new Error('Download interrompido: ' + (d.error || 'motivo desconhecido'));
    await esperar(1500);
  }
  throw new Error('Tempo esgotado aguardando o término do download.');
}

function partes(numero) {
  const m = numero.match(/^(\d{7})-(\d{2})\.(\d{4})\.(\d)\.(\d{2})\.(\d{4})$/);
  if (!m) throw new Error('Número em formato inválido: ' + numero);
  return { seq: m[1], dv: m[2], ano: m[3], j: m[4], tr: m[5], org: m[6] };
}

// ------------------------------------- funções executadas DENTRO do PJe ----
// (rodam no contexto da página; não podem usar variáveis de fora)

function pgPreencherEPesquisar(seq, dv, ano, org) {
  const g = id => document.getElementById(id);
  const botao = g('fPP:searchProcessos');
  if (!botao) return 'SEM_FORMULARIO';
  const definir = (id, v) => { const e = g(id); if (e) { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); } };
  definir('fPP:numeroProcesso:numeroSequencial', seq);
  definir('fPP:numeroProcesso:numeroDigitoVerificador', dv);
  definir('fPP:numeroProcesso:Ano', ano);
  definir('fPP:numeroProcesso:NumeroOrgaoJustica', org);
  botao.click();
  return 'ok';
}

function pgResultadoDaPesquisa(numero) {
  const link = [...document.querySelectorAll('a')].find(a => a.textContent.replace(/\s/g, '') === numero);
  if (link) return 'encontrado';
  if (/(^|\D)0 resultados? encontrados?/i.test(document.body.innerText)) return 'nenhum';
  return null;
}

function pgAbrirProcesso(numero) {
  // O PJe abre o processo com window.open; aqui ele é aberto na própria aba de trabalho.
  window.open = function (u) { location.href = u; return null; };
  const link = [...document.querySelectorAll('a')].find(a => a.textContent.replace(/\s/g, '') === numero);
  if (!link) return 'SEM_LINK';
  link.click();
  return 'ok';
}

function pgDetalhePronto() {
  if (/error\.seam/.test(location.pathname)) {
    return { erro: (document.body.innerText.match(/Sem permiss[^\n]*/) || ['Página de erro do PJe'])[0] };
  }
  const botao = [...document.querySelectorAll('#navbar input[type=button], #navbar input[type=submit], #navbar button')]
    .find(b => /^\s*download\s*$/i.test(b.value || b.textContent || ''));
  return botao ? { ok: true } : null;
}

function pgSolicitarDownload(op) {
  const selecionar = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); } };
  selecionar('navbar:cbCronologia', op.cronologia);
  selecionar('navbar:cbExpediente', op.expedientes ? 'true' : 'false');
  selecionar('navbar:cbMovimentos', op.movimentos ? 'true' : 'false');
  // Captura o endereço que o PJe abriria em nova janela depois de gerar o PDF.
  window.__pjeLoteUrl = null;
  window.open = function (u) { window.__pjeLoteUrl = String(u); return null; };
  const botao = [...document.querySelectorAll('#navbar input[type=button], #navbar input[type=submit], #navbar button')]
    .find(b => /^\s*download\s*$/i.test(b.value || b.textContent || ''));
  if (!botao) return 'SEM_BOTAO_DOWNLOAD';
  botao.click();
  return 'ok';
}

function pgUrlCapturada() {
  return window.__pjeLoteUrl ? new URL(window.__pjeLoteUrl, location.href).href : null;
}

function pgMensagemDoPainel() {
  const p = document.getElementById('panelAlertDownloadMessages');
  return p ? p.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
}

// A página /downloadAutosDigitais.seam devolve um pequeno HTML que cria um iframe
// apontando para o PDF no storage do tribunal (link temporário, válido ~2 min).
async function pgObterLinkDoPdf(urlIntermediaria, nomeArquivo) {
  const r = await fetch(urlIntermediaria, { credentials: 'include' });
  const tipo = (r.headers.get('content-type') || '').toLowerCase();
  if (/pdf|octet-stream|zip/.test(tipo)) {
    // Caso o PJe entregue o arquivo diretamente: dispara o download pela própria página.
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nomeArquivo;
    document.body.appendChild(a); a.click(); a.remove();
    return { viaPagina: true, bytes: blob.size };
  }
  const html = await r.text();
  const m = html.match(/\.src\s*=\s*['"]([^'"]+)['"]/) || html.match(/(https?:\/\/[^'"\s<>]+\.pdf[^'"\s<>]*)/i);
  if (m) {
    const url = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    return { url: new URL(url, location.href).href };
  }
  const texto = (new DOMParser().parseFromString(html, 'text/html').body || { innerText: '' }).innerText;
  return { erro: texto.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Resposta inesperada do PJe.' };
}

// ------------------------------------------------------ fluxo principal ----
// Chamada só por tratarMensagem, que já marcou `rodando` e zerou `pararSolicitado`.
async function executar() {
  let e;
  try { e = await alterarEstado(est => { est.rodando = true; }); }
  catch (err) { rodando = false; throw err; }
  const op = e.opcoes;
  const pendentes = e.itens.filter(i => i.status === 'pendente').map(i => i.numero);
  await registrar(`Iniciando: ${pendentes.length} processo(s). Pasta: Downloads/${op.pasta}`);

  let tabId = null;
  let sessaoCaiu = false;

  try {
    const aba = await browser.tabs.create({ url: 'about:blank', active: false });
    tabId = aba.id;
    for (let k = 0; k < pendentes.length; k++) {
      if (pararSolicitado) break;
      const numero = pendentes[k];
      await atualizarItem(numero, { status: 'processando', detalhe: 'Pesquisando…' });
      try {
        const r = await baixarUm(tabId, numero, op);
        await atualizarItem(numero, { status: 'ok', detalhe: r.detalhe, arquivo: r.arquivo });
        await registrar(`OK  ${numero} → ${r.arquivo}`);
      } catch (err) {
        const naoEncontrado = err.codigo === 'NAO_ENCONTRADO';
        sessaoCaiu = err.codigo === 'SESSAO';
        await atualizarItem(numero, { status: naoEncontrado ? 'nao_encontrado' : 'erro', detalhe: err.message });
        await registrar(`${naoEncontrado ? 'NÃO ENCONTRADO' : 'ERRO'}  ${numero}: ${err.message}`);
        if (sessaoCaiu) {
          await registrar('Sessão do PJe indisponível. Faça login no PJe e clique em "Retomar".');
          break;
        }
      }
      if (k < pendentes.length - 1 && !pararSolicitado) await esperar(op.intervalo * 1000);
    }
  } finally {
    e = await alterarEstado(est => {
      est.rodando = false;
      est.itens.forEach(i => { if (i.status === 'processando') i.status = 'interrompido'; });
    });
    const ok = e.itens.filter(i => i.status === 'ok').length;
    await registrar(`Fim. ${ok} de ${e.itens.length} baixado(s).${pararSolicitado ? ' (parado pelo usuário)' : ''}`);
    if (tabId !== null && !op.manterAba && !sessaoCaiu) { try { await browser.tabs.remove(tabId); } catch (_) {} }
    rodando = false;
  }
}

function erroCom(codigo, mensagem) { const e = new Error(mensagem); e.codigo = codigo; return e; }

async function baixarUm(tabId, numero, op) {
  const p = partes(numero);
  if (p.j !== '8' || p.tr !== '18') throw erroCom('FORMATO', 'Número não é do TJPI (segmento .8.18.).');

  // 1) Consulta de processos
  const tab = await navegar(tabId, URL_CONSULTA);
  if (!tab || !/ConsultaProcesso\/listView\.seam/.test(tab.url || '')) throw erroCom('SESSAO', 'A tela de consulta não abriu (sessão expirada ou PJe fora do ar).');
  const preenchido = await aguardarNaPagina(tabId, pgPreencherEPesquisar, [p.seq, p.dv, p.ano, p.org], 15000);
  if (preenchido !== 'ok') throw erroCom('SESSAO', 'Formulário de consulta não encontrado (sessão expirada?).');

  // 2) Resultado da pesquisa
  const resultado = await aguardarNaPagina(tabId, pgResultadoDaPesquisa, [numero], 30000);
  if (resultado === 'nenhum') throw erroCom('NAO_ENCONTRADO', 'Pesquisa não retornou resultado.');
  if (resultado !== 'encontrado') throw erroCom('TEMPO', 'Pesquisa não respondeu a tempo.');

  // 3) Abre o processo (autos digitais)
  await atualizarItem(numero, { detalhe: 'Abrindo o processo…' });
  const aberto = await rodarNaPagina(tabId, pgAbrirProcesso, [numero]);
  if (aberto !== 'ok') throw erroCom('LINK', 'Link do processo não encontrado no resultado.');
  const det = await aguardarCarregamento(tabId, /listAutosDigitais\.seam|error\.seam/, 45000);
  if (!det) throw erroCom('TEMPO', 'O processo não abriu a tempo.');
  const pronto = await aguardarNaPagina(tabId, pgDetalhePronto, [], 30000);
  if (!pronto) throw erroCom('TEMPO', 'Tela do processo carregou sem o botão de download.');
  if (pronto.erro) throw erroCom('PERMISSAO', pronto.erro);

  // 4) Clica em DOWNLOAD e espera o PJe gerar o PDF
  await atualizarItem(numero, { detalhe: 'Gerando PDF no PJe…' });
  const pedido = await rodarNaPagina(tabId, pgSolicitarDownload, [op]);
  if (pedido !== 'ok') throw erroCom('BOTAO', 'Botão DOWNLOAD não encontrado.');
  const urlIntermediaria = await aguardarNaPagina(tabId, pgUrlCapturada, [], op.tempoGeracao * 1000, 1000);
  if (!urlIntermediaria) {
    const msg = await rodarNaPagina(tabId, pgMensagemDoPainel, []).catch(() => '');
    throw erroCom('GERACAO', 'O PJe não liberou o arquivo a tempo.' + (msg ? ' Mensagem do PJe: ' + msg : ''));
  }

  // 5) Baixa o PDF
  await atualizarItem(numero, { detalhe: 'Baixando…' });
  const nome = `${op.pasta}/${numero}.pdf`;
  const inicio = Date.now();
  const link = await rodarNaPagina(tabId, pgObterLinkDoPdf, [urlIntermediaria, `${numero}.pdf`]);
  if (!link) throw erroCom('LINK_PDF', 'Não foi possível obter o link do PDF.');
  if (link.erro) throw erroCom('LINK_PDF', 'PJe respondeu: ' + link.erro);

  let item;
  if (link.url) {
    const id = await browser.downloads.download({ url: link.url, filename: nome, conflictAction: 'uniquify', saveAs: false });
    item = await aguardarDownload(id, op.tempoDownload * 1000);
  } else {
    // arquivo entregue direto pela página: localiza o download recém-criado
    let achado = null;
    for (let t = 0; t < 20 && !achado; t++) {
      const lista = await browser.downloads.search({ orderBy: ['-startTime'], limit: 5 });
      achado = lista.find(d => new Date(d.startTime).getTime() >= inicio - 2000 && (d.filename || '').includes(numero));
      if (!achado) await esperar(1000);
    }
    if (!achado) throw erroCom('DOWNLOAD', 'Download iniciado pela página, mas não localizado.');
    item = await aguardarDownload(achado.id, op.tempoDownload * 1000);
  }
  const mb = (item.fileSize || item.totalBytes || 0) / 1048576;
  return { arquivo: item.filename.split(/[\\/]/).slice(-2).join('/'), detalhe: `${mb.toFixed(1)} MB` };
}
