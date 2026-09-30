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

function escapar(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function desenhar(estado) {
  const itens = estado.itens || [];
  const total = itens.length;
  const cont = s => itens.filter(i => i.status === s).length;
  const feitos = itens.filter(i => !['pendente', 'processando'].includes(i.status)).length;
  $('resumo').textContent = total
    ? `${estado.rodando ? 'Em andamento' : 'Parado'} · ${cont('ok')} baixado(s), ${cont('erro')} erro(s), ${cont('nao_encontrado')} não encontrado(s), ${cont('pendente') + cont('interrompido')} pendente(s) — de ${total}`
    : 'Nenhuma execução.';
  $('progresso').style.width = total ? `${Math.round((feitos / total) * 100)}%` : '0';
  $('itens').innerHTML = itens.map(i =>
    `<tr><td class="num">${escapar(i.numero)}</td><td class="st-${i.status}">${ROTULOS[i.status] || i.status}</td><td>${escapar(i.status === 'ok' ? i.arquivo + ' · ' + i.detalhe : i.detalhe)}</td></tr>`
  ).join('');
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
  const { estado } = await chrome.storage.local.get('estado');
  return estado || { rodando: false, itens: [], log: [] };
}

function enviar(msg) {
  return new Promise(res => chrome.runtime.sendMessage(msg, r => res(r || {})));
}

$('lista').addEventListener('input', () => {
  atualizarContagem();
  chrome.storage.local.set({ rascunho: $('lista').value });
});

$('btnIniciar').addEventListener('click', async () => {
  const numeros = extrairNumeros($('lista').value);
  if (!numeros.length) { alert('Nenhum número de processo reconhecido na lista.'); return; }
  const estado = await estadoAtual();
  const pend = (estado.itens || []).filter(i => ['pendente', 'interrompido'].includes(i.status)).length;
  if (pend && !confirm(`Há ${pend} processo(s) pendente(s) da execução anterior. Iniciar uma nova lista descarta esse andamento. Continuar?`)) return;
  const opcoes = lerOpcoes();
  chrome.storage.local.set({ opcoesSalvas: opcoes });
  const r = await enviar({ cmd: 'iniciar', numeros, opcoes });
  if (!r.ok) alert(r.erro || 'Não foi possível iniciar.');
});

$('btnParar').addEventListener('click', () => enviar({ cmd: 'parar' }));
$('btnRetomar').addEventListener('click', async () => {
  const opcoes = lerOpcoes(); chrome.storage.local.set({ opcoesSalvas: opcoes });
  const r = await enviar({ cmd: 'retomar', incluirErros: false, opcoes }); if (!r.ok) alert(r.erro);
});
$('btnRepetir').addEventListener('click', async () => {
  const opcoes = lerOpcoes(); chrome.storage.local.set({ opcoesSalvas: opcoes });
  const r = await enviar({ cmd: 'retomar', incluirErros: true, opcoes }); if (!r.ok) alert(r.erro);
});
$('btnLimpar').addEventListener('click', async () => {
  if (!confirm('Apagar a lista de andamento e o registro? (os arquivos já baixados não são afetados)')) return;
  const r = await enviar({ cmd: 'limpar' }); if (!r.ok) alert(r.erro);
});

$('btnCsv').addEventListener('click', async () => {
  const e = await estadoAtual();
  const linhas = [['processo', 'situacao', 'arquivo', 'detalhe', 'atualizado_em']]
    .concat((e.itens || []).map(i => [i.numero, ROTULOS[i.status] || i.status, i.arquivo || '', i.detalhe || '', i.atualizadoEm || '']));
  const csv = '\ufeff' + linhas.map(l => l.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const carimbo = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  chrome.downloads.download({ url, filename: `${lerOpcoes().pasta}/relatorio-${carimbo}.csv`, saveAs: false });
});

chrome.storage.onChanged.addListener((mud, area) => {
  if (area === 'local' && mud.estado) desenhar(mud.estado.newValue || { itens: [], log: [] });
});

(async () => {
  const { rascunho, opcoesSalvas } = await chrome.storage.local.get(['rascunho', 'opcoesSalvas']);
  if (rascunho) $('lista').value = rascunho;
  aplicarOpcoes(opcoesSalvas);
  atualizarContagem();
  desenhar(await estadoAtual());
})();
