const $ = id => document.getElementById(id);
const ROTULOS = { pendente: 'Pendente', processando: 'Baixando…', ok: 'Baixado', erro: 'Erro', nao_encontrado: 'Não encontrado', interrompido: 'Interrompido' };

// Aceita "0800992-39.2024.8.18.0056", "08009923920248180056" ou variações com espaços.
function extrairNumeros(texto) {
  const achados = texto.match(/\d{7}\s*-?\s*\d{2}\s*\.?\s*\d{4}\s*\.?\s*\d\s*\.?\s*\d{2}\s*\.?\s*\d{4}/g) || [];
  const vistos = new Set();
  const lista = [];
  for (const bruto of achados) {
    const d = bruto.replace(/\D/g, '');
    const n = `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16, 20)}`;
    if (!vistos.has(n)) { vistos.add(n); lista.push(n); }
  }
  return lista;
}

function lerOpcoes() {
  return {
    cronologia: $('cronologia').value,
    expedientes: $('expedientes').value === 'true',
    movimentos: $('movimentos').value === 'true',
    pasta: ($('pasta').value || 'PJe-autos').replace(/[<>:"\\|?*]/g, '').replace(/^\/+|\/+$/g, '') || 'PJe-autos',
    intervalo: Math.max(1, +$('intervalo').value || 5),
    tempoGeracao: Math.max(30, +$('tempoGeracao').value || 300),
    tempoDownload: Math.max(30, +$('tempoDownload').value || 900),
    manterAba: $('manterAba').checked,
  };
}

function aplicarOpcoes(o) {
  if (!o) return;
  $('cronologia').value = o.cronologia;
  $('expedientes').value = String(!!o.expedientes);
  $('movimentos').value = String(!!o.movimentos);
  $('pasta').value = o.pasta;
  $('intervalo').value = o.intervalo;
  $('tempoGeracao').value = o.tempoGeracao;
  $('tempoDownload').value = o.tempoDownload;
  $('manterAba').checked = !!o.manterAba;
}

function atualizarContagem() {
  const n = extrairNumeros($('lista').value).length;
  $('contagem').textContent = `${n} processo${n === 1 ? '' : 's'} reconhecido${n === 1 ? '' : 's'}`;
}

function desenhar(estado) {
  const itens = estado.itens || [];
  const total = itens.length;
  const cont = s => itens.filter(i => i.status === s).length;
  const feitos = itens.filter(i => !['pendente', 'processando'].includes(i.status)).length;
  $('resumo').textContent = total
    ? `${estado.rodando ? 'Em andamento' : 'Parado'} · ${cont('ok')} baixado(s), ${cont('erro')} erro(s), ${cont('nao_encontrado')} não encontrado(s), ${cont('pendente') + cont('interrompido')} pendente(s) — de ${total}`
    : 'Nenhuma execução.';
  $('progresso').style.width = total ? `${Math.round((feitos / total) * 100)}%` : '0';
  $('itens').replaceChildren(...itens.map(i => {
    const tr = document.createElement('tr');
    const celula = (texto, classe) => {
      const td = document.createElement('td');
      if (classe) td.className = classe;
      td.textContent = texto || '';
      tr.appendChild(td);
    };
    celula(i.numero, 'num');
    celula(ROTULOS[i.status] || i.status, `st-${i.status}`);
    celula(i.status === 'ok' ? i.arquivo + ' · ' + i.detalhe : i.detalhe);
    return tr;
  }));
  $('log').textContent = (estado.log || []).join('\n');
  $('log').scrollTop = $('log').scrollHeight;

  const temPendente = itens.some(i => ['pendente', 'interrompido'].includes(i.status));
  const temFalha = itens.some(i => ['erro', 'nao_encontrado'].includes(i.status));
  $('btnIniciar').disabled = !!estado.rodando;
  $('btnParar').disabled = !estado.rodando;
  $('btnRetomar').disabled = !!estado.rodando || !temPendente;
  $('btnRepetir').disabled = !!estado.rodando || !temFalha;
  $('btnLimpar').disabled = !!estado.rodando || !total;
  $('btnCsv').disabled = !total;
  $('lista').disabled = !!estado.rodando;
}

async function estadoAtual() {
  const { estado } = await browser.storage.local.get('estado');
  return estado || { rodando: false, itens: [], log: [] };
}

async function enviar(msg) {
  try { return (await browser.runtime.sendMessage(msg)) || {}; }
  catch (err) { return { ok: false, erro: err.message }; }
}

// O Firefox não exibe as caixas nativas de alerta/confirmação dentro do painel
// de extensões; por isso os avisos e as perguntas aparecem no próprio painel.
function avisar(texto) {
  return perguntar(texto, { soOk: true });
}

function perguntar(texto, { soOk = false } = {}) {
  return new Promise(resolver => {
    const caixa = $('dialogo');
    $('dialogoTexto').textContent = texto;
    $('dialogoNao').hidden = soOk;
    $('dialogoSim').textContent = soOk ? 'OK' : 'Sim, continuar';
    caixa.hidden = false;
    caixa.scrollIntoView({ block: 'nearest' });
    const fechar = resposta => {
      caixa.hidden = true;
      $('dialogoSim').onclick = $('dialogoNao').onclick = null;
      resolver(resposta);
    };
    $('dialogoSim').onclick = () => fechar(true);
    $('dialogoNao').onclick = () => fechar(false);
    $('dialogoSim').focus();
  });
}

$('lista').addEventListener('input', () => {
  atualizarContagem();
  browser.storage.local.set({ rascunho: $('lista').value });
});

$('btnIniciar').addEventListener('click', async () => {
  const numeros = extrairNumeros($('lista').value);
  if (!numeros.length) { await avisar('Nenhum número de processo reconhecido na lista.'); return; }
  const estado = await estadoAtual();
  const pend = (estado.itens || []).filter(i => ['pendente', 'interrompido'].includes(i.status)).length;
  if (pend && !(await perguntar(`Há ${pend} processo(s) pendente(s) da execução anterior. Iniciar uma nova lista descarta esse andamento. Continuar?`))) return;
  const opcoes = lerOpcoes();
  browser.storage.local.set({ opcoesSalvas: opcoes });
  const r = await enviar({ cmd: 'iniciar', numeros, opcoes });
  if (!r.ok) await avisar(r.erro || 'Não foi possível iniciar.');
});

$('btnParar').addEventListener('click', () => enviar({ cmd: 'parar' }));
$('btnRetomar').addEventListener('click', async () => {
  const opcoes = lerOpcoes(); browser.storage.local.set({ opcoesSalvas: opcoes });
  const r = await enviar({ cmd: 'retomar', incluirErros: false, opcoes }); if (!r.ok) await avisar(r.erro || 'Não foi possível executar o comando.');
});
$('btnRepetir').addEventListener('click', async () => {
  const opcoes = lerOpcoes(); browser.storage.local.set({ opcoesSalvas: opcoes });
  const r = await enviar({ cmd: 'retomar', incluirErros: true, opcoes }); if (!r.ok) await avisar(r.erro || 'Não foi possível executar o comando.');
});
$('btnLimpar').addEventListener('click', async () => {
  if (!(await perguntar('Apagar a lista de andamento e o registro? (os arquivos já baixados não são afetados)'))) return;
  const r = await enviar({ cmd: 'limpar' }); if (!r.ok) await avisar(r.erro || 'Não foi possível executar o comando.');
});

// O CSV é gerado pela página de fundo: se fosse gerado aqui, o Firefox fecharia
// o painel ao iniciar o download e o arquivo temporário deixaria de existir.
$('btnCsv').addEventListener('click', async () => {
  const r = await enviar({ cmd: 'csv', rotulos: ROTULOS, pasta: lerOpcoes().pasta });
  if (!r.ok) await avisar('Não foi possível exportar o relatório: ' + (r.erro || 'erro desconhecido'));
});

browser.storage.onChanged.addListener((mud, area) => {
  if (area === 'local' && mud.estado) desenhar(mud.estado.newValue || { itens: [], log: [] });
});

(async () => {
  const { rascunho, opcoesSalvas } = await browser.storage.local.get(['rascunho', 'opcoesSalvas']);
  if (rascunho) $('lista').value = rascunho;
  aplicarOpcoes(opcoesSalvas);
  atualizarContagem();
  desenhar(await estadoAtual());
})();
