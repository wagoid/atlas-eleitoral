'use strict';
// Todo texto externo inserido em markup passa por esc(); números vêm do dataset validado pelo pipeline.
const $ = id => document.getElementById(id);
const fmt = n => n === null || n === undefined ? 'n/d' : Number(n).toLocaleString('pt-BR');
const pct = n => n === null || !Number.isFinite(n) ? 'não calculável' : n.toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + '%';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const normal = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const PALETTE = ['#4057bd', '#39bcde', '#53d5af', '#f5de65', '#ef665f'];
const PAGE_SIZE = 100;
const BRAZIL_VIEW = [[-33.8, -74], [5.3, -34.8]];
const color = t => PALETTE[Math.min(4, Math.max(0, Math.floor(t * 5)))];
const plotted = p => p.status === 1 || p.status === 3;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {office: 1, uf: '', mun: '', metric: '', view: '', page: 0, selected: null};
const requests = new Map();
let META, BR, GEO_BR;
let UF = null, GEO_UF = null, MUN = null;
let KEYS = [], units = [], territory = {}, places = [], placeRows = [], sectionRows = [];
let rowData = [], filtered = [], areaLayer = null, areaByUnit = new Map(), heat = null;
let tilesLoaded = 0, tilesFailed = 0;

function load(path) {
  if (!requests.has(path)) {
    requests.set(path, fetch('data/' + path).then(r => {
      if (!r.ok) throw new Error(path + ': HTTP ' + r.status);
      return r.json();
    }));
  }
  return requests.get(path);
}

const level = () => state.mun ? 'mun' : state.uf ? 'uf' : 'br';
const office = () => META.offices.find(o => o.code === state.office);
const ufName = uf => (META.ufs.find(u => u.uf === uf) || {}).name || uf;
const territoryName = () => level() === 'mun' ? `${MUN.name} (${state.uf})` : level() === 'uf' ? ufName(state.uf) : 'Brasil';
const upKey = () => state.office === 1 ? '1.80' : state.office + '.up';

function toObjects(cols, rows, offset, head) {
  const offices = META.offices.map(o => o.code).filter(code => cols.includes(code + '.blank'));
  return rows.map(r => {
    const o = head(r);
    cols.forEach((c, i) => { o[c] = r[offset + i]; });
    for (const code of offices) {
      const blank = o[code + '.blank'], nulls = o[code + '.null'];
      o[code + '.bn'] = blank === null || nulls === null ? null : blank + nulls;
    }
    return o;
  });
}

function withDerived(cols) {
  return [...cols, ...META.offices.map(o => o.code + '.bn').filter(k => cols.includes(k.replace('.bn', '.blank')))];
}

function sumRows(list, keys) {
  const total = {};
  for (const k of keys) {
    let s = null;
    for (const r of list) {
      const v = r[k];
      if (v !== null && v !== undefined) s = (s ?? 0) + v;
    }
    total[k] = s;
  }
  return total;
}

function metricList() {
  const o = state.office;
  const list = [];
  if (o === 1) {
    for (const c of META.president) list.push({key: '1.' + c.n, name: `${c.name} (${c.party} ${c.n})`, short: c.name, kind: 'cand'});
  } else {
    list.push({key: o + '.up', name: 'UP no cargo (candidaturas + legenda)', short: 'UP no cargo', kind: 'cand'});
    if (level() !== 'br') {
      for (const v of ((META.up[state.uf] || {})[o] || [])) {
        list.push({key: o + '.' + v.n, name: v.kind === 'legenda' ? 'Legenda UP (80)' : `${v.name} (UP ${v.n})`, short: v.kind === 'legenda' ? 'Legenda UP' : v.name, kind: 'cand'});
      }
    }
  }
  list.push(
    {key: o + '.valid', name: 'Votos válidos', short: 'Válidos', kind: 'vote'},
    {key: o + '.bn', name: 'Brancos e nulos', short: 'Brancos e nulos', kind: 'vote'},
    {key: o + '.blank', name: 'Brancos', short: 'Brancos', kind: 'vote'},
    {key: o + '.null', name: 'Nulos', short: 'Nulos', kind: 'vote'},
    {key: 'abst', name: 'Abstenções', short: 'Abstenções', kind: 'people'},
    {key: 'comp', name: 'Comparecimentos', short: 'Comparecimentos', kind: 'people'},
    {key: 'aptos', name: 'Eleitorado apto', short: 'Aptos', kind: 'aptos'},
  );
  return list;
}
const metric = key => metricList().find(m => m.key === (key || state.metric));

function officeVotes(obj) {
  const o = state.office;
  const parts = [obj[o + '.valid'], obj[o + '.blank'], obj[o + '.null']];
  return parts.some(v => v === null || v === undefined) ? null : parts.reduce((a, b) => a + b, 0);
}
function denominator(obj, m) {
  if (m.kind === 'cand') return obj[state.office + '.valid'];
  if (m.kind === 'vote') return officeVotes(obj);
  if (m.kind === 'people') return obj.aptos;
  return territory.aptos;
}
function baseLabel(m) {
  if (m.kind === 'cand') return 'dos válidos';
  if (m.kind === 'vote') return office().votes_per_voter > 1 ? `dos votos do cargo (${office().votes_per_voter} por eleitor)` : 'dos comparecimentos';
  if (m.kind === 'people') return 'dos aptos';
  return 'dos aptos do recorte';
}
function rate(obj, key) {
  const m = metric(key);
  const value = obj[m.key], den = denominator(obj, m);
  return value === null || value === undefined || !(den > 0) ? null : 100 * value / den;
}

const map = L.map('map', {scrollWheelZoom: false});
map.fitBounds(BRAZIL_VIEW);
const tiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  attribution: 'Tiles Esri, <a href="https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer" target="_blank" rel="noopener">Esri, HERE, Garmin, USGS e colaboradores</a> | Malhas IBGE | Dados TSE',
}).addTo(map);
tiles.on('tileload', () => { tilesLoaded++; $('tiles-status').textContent = 'Mapa-base online: Esri World Street Map. Dados e malhas servidos pelo próprio site.'; });
tiles.on('tileerror', () => { tilesFailed++; $('tiles-status').textContent = 'Parte do mapa-base não carregou. Áreas, pontos, dados e filtros continuam disponíveis.'; });
L.control.scale({imperial: false}).addTo(map);
const markers = L.layerGroup().addTo(map);
const outline = L.layerGroup().addTo(map);

function setLoading(on) { $('loading').hidden = !on; }

async function setTerritory(uf, mun) {
  setLoading(true);
  try {
    state.uf = uf || '';
    state.mun = mun || '';
    state.selected = null;
    state.page = 0;
    if (state.uf === 'ZZ' && state.office !== 1) state.office = 1;
    UF = state.uf ? await load(`uf/${state.uf}.json`) : null;
    GEO_UF = state.uf && state.uf !== 'ZZ' ? await load(`geo/${state.uf}.json`) : null;
    MUN = state.mun ? await load(`mun/${state.mun}.json`) : null;
    if (state.mun && !MUN) state.mun = '';
    prepare();
    syncTerritoryControls();
    buildAreas();
    clearFilters();
    refreshMetricOptions();
    renderAll();
    frameTerritory();
  } catch (error) {
    $('filter-stats').textContent = 'Não foi possível carregar os dados: ' + error.message;
    window.ATLAS_QA.errors.push(String(error));
  } finally {
    setLoading(false);
  }
}

function prepare() {
  const lvl = level();
  if (lvl === 'br') {
    KEYS = withDerived(BR.cols);
    units = toObjects(BR.cols, BR.rows, 5, r => ({id: r[0], name: r[1], munis: r[2], places: r[3], sections: r[4]}));
    territory = sumRows(units, KEYS);
  } else if (lvl === 'uf') {
    KEYS = withDerived(UF.cols);
    units = toObjects(UF.cols, UF.rows, 6, r => ({id: r[0], ibge: r[1], name: r[2], places: r[3], sections: r[4], mapped: r[5]}));
    territory = sumRows(units, KEYS);
  } else {
    KEYS = withDerived(MUN.cols);
    places = MUN.places.map((p, i) => ({idx: i, zone: p[0], local: p[1], name: p[2], address: p[3], neighborhood: p[4] || 'Sem bairro no cadastro', lat: p[5], lon: p[6], status: p[7]}));
    const sections = toObjects(MUN.cols, MUN.sections, 3, r => ({zone: r[0], section: r[1], place: r[2]}));
    sectionRows = sections.map(s => ({...places[s.place], ...s, kind: 'section', sections: 1, sectionIds: [s.section]}));
    placeRows = aggregate(sectionRows);
    units = placeRows;
    territory = sumRows(sectionRows, KEYS);
  }
  territory.sections = units.reduce((a, u) => a + u.sections, 0);
}

function aggregate(rows) {
  const groups = new Map();
  for (const s of rows) {
    let a = groups.get(s.place);
    if (!a) {
      a = {...places[s.place], kind: 'place', sections: 0, sectionIds: []};
      for (const k of KEYS) a[k] = 0;
      groups.set(s.place, a);
    }
    a.sections += 1;
    a.sectionIds.push(s.section);
    for (const k of KEYS) a[k] += s[k];
  }
  return [...groups.values()];
}

function syncTerritoryControls() {
  $('office').innerHTML = META.offices.map(o => `<option value="${o.code}"${o.code === state.office ? ' selected' : ''}${state.uf === 'ZZ' && o.code !== 1 ? ' disabled' : ''}>${esc(o.name)}${o.scope === 'up' ? ' (somente UP)' : ''}</option>`).join('');
  $('uf').value = state.uf;
  const munSelect = $('mun');
  munSelect.innerHTML = '<option value="">Todos os municípios</option>' + (UF ? UF.rows.map(r => `<option value="${esc(r[0])}">${esc(r[2])}</option>`).join('') : '');
  munSelect.disabled = !UF;
  munSelect.value = state.mun;
  const crumbs = [`<button type="button" data-go=""${level() === 'br' ? ' aria-current="page"' : ''}>Brasil</button>`];
  if (state.uf) crumbs.push(`<button type="button" data-go="${esc(state.uf)}"${level() === 'uf' ? ' aria-current="page"' : ''}>${esc(ufName(state.uf))}</button>`);
  if (state.mun) crumbs.push(`<button type="button" aria-current="page" data-go="${esc(state.uf)}|${esc(state.mun)}">${esc(MUN.name)}</button>`);
  $('crumbs').innerHTML = crumbs.join('<span aria-hidden="true">/</span>');
  const isMun = level() === 'mun';
  for (const id of ['zone', 'neighborhood', 'unit', 'section-filter']) $(id).disabled = !isMun;
  $('zone').innerHTML = '<option value="">Todas as zonas</option>' + (isMun ? [...new Set(places.map(p => p.zone))].sort((a, b) => a - b).map(z => `<option value="${z}">Zona ${z}</option>`).join('') : '');
  $('neighborhood').innerHTML = '<option value="">Todos os bairros</option>' + (isMun ? [...new Set(places.map(p => p.neighborhood))].sort((a, b) => a.localeCompare(b, 'pt-BR')).map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('') : '');
  $('view').innerHTML = (isMun
    ? [['heat', 'Calor: contagem'], ['count', 'Círculos: contagem'], ['rate', 'Círculos: percentual']]
    : [['choro', 'Áreas: percentual'], ['count', 'Círculos: contagem']]
  ).map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  const views = [...$('view').options].map(o => o.value);
  state.view = views.includes(state.view) ? state.view : views[0];
  $('view').value = state.view;
}

function refreshMetricOptions() {
  const list = metricList().filter(m => KEYS.includes(m.key));
  if (!list.some(m => m.key === state.metric)) state.metric = upKey();
  $('metric').innerHTML = list.map(m => `<option value="${esc(m.key)}"${m.key === state.metric ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
}

function featureId(feature) { return level() === 'br' ? feature.properties.uf : feature.properties.tse; }

function buildAreas() {
  if (areaLayer) map.removeLayer(areaLayer);
  areaLayer = null;
  areaByUnit = new Map();
  outline.clearLayers();
  const lvl = level();
  if (lvl === 'mun') {
    const feature = GEO_UF && GEO_UF.features.find(f => f.properties.tse === state.mun);
    if (feature) L.geoJSON(feature, {style: {color: '#b7a7ff', weight: 2, fillOpacity: .035, dashArray: '5 6'}, interactive: false}).addTo(outline);
    return;
  }
  const collection = lvl === 'br' ? GEO_BR : GEO_UF;
  if (!collection) return;
  areaLayer = L.geoJSON(collection, {
    style: {weight: .8, color: '#0b1423', fillOpacity: .7},
    onEachFeature: (feature, layer) => {
      areaByUnit.set(featureId(feature), layer);
      layer.on('click', () => drill(featureId(feature)));
    },
  }).addTo(map);
  areaLayer.eachLayer(layer => {
    const el = layer.getElement && layer.getElement();
    if (!el) return;
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.classList.add('unit-shape');
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drill(featureId(layer.feature)); }
    });
  });
  if (lvl === 'uf') L.geoJSON(collection, {style: {color: '#b7a7ff', weight: 0, fillOpacity: 0}, interactive: false}).addTo(outline);
}

function drill(id) {
  if (level() === 'br') return navigate(id, '');
  if (level() === 'uf') return navigate(state.uf, id);
}

function navigate(uf, mun) {
  setTerritory(uf, mun).then(writeHash);
}

function frameTerritory() {
  const lvl = level();
  if (lvl === 'br') return map.fitBounds(BRAZIL_VIEW);
  if (state.uf === 'ZZ') return map.setView([20, -20], 2);
  if (lvl === 'uf' && areaLayer) return map.fitBounds(areaLayer.getBounds(), {padding: [10, 10]});
  const mapped = placeRows.filter(plotted);
  if (mapped.length) return map.fitBounds(L.latLngBounds(mapped.map(p => [p.lat, p.lon])), {padding: [30, 30], maxZoom: 15});
  const layers = outline.getLayers();
  if (layers.length) map.fitBounds(layers[0].getBounds(), {padding: [20, 20]});
}

function clearFilters() {
  for (const id of ['zone', 'neighborhood', 'query', 'section-filter', 'min-value', 'max-value']) $(id).value = '';
  $('unit').value = 'place';
  $('range-kind').value = 'count';
  $('sort').value = level() === 'mun' ? 'name' : 'count-desc';
  state.page = 0;
  state.selected = null;
  map.closePopup();
}

function renderAll() {
  renderHeader();
  render();
  renderTerritoryTables();
  renderCandidates();
}

function renderHeader() {
  const o = office(), name = territoryName(), lvl = level();
  $('hero-over').textContent = `${o.name}${o.scope === 'up' ? ' (somente UP)' : ''} - 1º turno - 04 de outubro de 2026`;
  $('hero-title').innerHTML = `${esc(lvl === 'mun' ? MUN.name : name)},<br>no mapa dos resultados.`;
  document.title = `${lvl === 'br' ? 'Brasil' : name} 2026 - Atlas eleitoral`;
  const chips = [];
  if (lvl === 'br') {
    const abroad = units.find(u => u.id === 'ZZ');
    chips.push(`${fmt(units.filter(u => u.id !== 'ZZ').reduce((a, u) => a + u.munis, 0))} municípios`);
    if (abroad) chips.push(`${fmt(abroad.munis)} cidades no exterior`);
  }
  if (lvl === 'uf') chips.push(`${fmt(units.length)} municípios`);
  const placesCount = lvl === 'mun' ? placeRows.length : units.reduce((a, u) => a + u.places, 0);
  chips.push(`${fmt(placesCount)} locais de votação`, `${fmt(territory.sections)} boletins`);
  if (lvl === 'mun') chips.push(`${new Set(places.map(p => p.zone)).size} zonas eleitorais`);
  chips.push('TSE + IBGE + Esri');
  $('chips').innerHTML = chips.map(c => `<span class="chip">${esc(c)}</span>`).join('');
  $('coverage').innerHTML = `<strong>${fmt(territory.comp)}</strong><br>comparecimentos<br><span class="small">${pct(100 * territory.comp / territory.aptos)} de ${fmt(territory.aptos)} aptos</span><p class="small" style="margin-top:15px">Totalização TSE: ${esc(META.election.feed_generated)}.<br>Dados gerados em ${esc(new Date(META.generated_at).toLocaleString('pt-BR'))}.</p>`;

  const list = metricList();
  const cand = list.filter(m => m.kind === 'cand' && territory[m.key] !== undefined && territory[m.key] !== null);
  let cardKeys;
  if (state.office === 1) {
    const top = cand.slice().sort((a, b) => territory[b.key] - territory[a.key]).slice(0, 3).map(m => m.key);
    if (!top.includes('1.80')) top.push('1.80');
    cardKeys = ['aptos', 'comp', 'abst', ...top, '1.valid', '1.blank', '1.null'];
  } else {
    const extra = cand.filter(m => m.key !== upKey()).sort((a, b) => territory[b.key] - territory[a.key]).slice(0, 2).map(m => m.key);
    cardKeys = ['aptos', 'comp', 'abst', upKey(), ...extra, state.office + '.valid', state.office + '.blank', state.office + '.null'];
  }
  $('city-cards').innerHTML = cardKeys.map(k => {
    const m = metric(k);
    const sub = k === 'aptos' ? 'Eleitorado apto no resultado' : `${pct(rate(territory, k))} ${baseLabel(m)}`;
    return `<div class="card"><div class="name">${esc(m.name)}</div><div class="value">${fmt(territory[k])}</div><div class="sub">${esc(sub)}</div></div>`;
  }).join('');
  renderUpNote();
}

function renderUpNote() {
  const o = office(), key = upKey(), lvl = level();
  if (state.uf === 'ZZ' && state.office !== 1) return;
  if (territory[key] === null || territory[key] === undefined) {
    $('up-note').innerHTML = `<strong>Unidade Popular.</strong> Não há dado da UP para ${esc(o.name)} neste recorte.`;
    return;
  }
  let text;
  if (state.office === 1) {
    const sample = lvl === 'mun' ? ` Há votos em ${fmt(sectionRows.filter(s => s['1.80'] > 0).length)} BUs de ${fmt(placeRows.filter(p => p['1.80'] > 0).length)} locais.` : '';
    text = `<strong>Unidade Popular, Samara (80).</strong> ${fmt(territory[key])} votos presidenciais em ${esc(territoryName())}, ${pct(rate(territory, key))} dos válidos.${sample} O indicador da UP abre selecionado; use mínimo 1 para ocultar registros sem votos. Lula e Flávio Bolsonaro estão no seletor de indicador para comparação.`;
  } else {
    const votables = lvl === 'br' ? null : ((META.up[state.uf] || {})[state.office] || []);
    const missing = votables && !votables.length ? ` A UP não teve candidatura válida a ${esc(o.name)} em ${esc(ufName(state.uf))}.` : '';
    text = `<strong>Unidade Popular, ${esc(o.name)}.</strong> ${fmt(territory[key])} votos em ${esc(territoryName())} (candidaturas + legenda), ${pct(rate(territory, key))} dos válidos do cargo.${missing} Para este cargo o atlas guarda somente a UP; válidos, brancos e nulos servem de denominador.${lvl === 'br' ? ' Escolha um estado para ver cada candidatura.' : ''}`;
  }
  $('up-note').innerHTML = text + ' As coordenadas são dos locais de votação, não dos eleitores.';
}

function readFilters() {
  const low = $('min-value').value === '' ? null : Number($('min-value').value);
  const high = $('max-value').value === '' ? null : Number($('max-value').value);
  return {
    k: state.metric,
    zone: $('zone').value,
    neighborhood: $('neighborhood').value,
    query: normal($('query').value.trim()),
    isSection: level() === 'mun' && $('unit').value === 'section',
    section: $('section-filter').value.trim(),
    rangeKind: $('range-kind').value,
    low, high,
    badRange: [low, high].some(v => v !== null && (!Number.isFinite(v) || v < 0)) || (low !== null && high !== null && low > high),
  };
}

function sortRows(rows, order, k) {
  const value = r => order.startsWith('rate') ? rate(r, k) : r[k];
  const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR') || (a.section || 0) - (b.section || 0);
  rows.sort((a, b) => {
    if (order === 'name') return byName(a, b);
    if (order === 'section') return (a.zone || 0) - (b.zone || 0) || (a.section || a.local || 0) - (b.section || b.local || 0) || byName(a, b);
    const va = value(a), vb = value(b);
    if (va === null && vb === null) return byName(a, b);
    if (va === null) return 1;
    if (vb === null) return -1;
    return (order.endsWith('desc') ? vb - va : va - vb) || byName(a, b);
  });
}

function render() {
  const f = readFilters(), lvl = level(), m = metric(f.k);
  const base = lvl === 'mun' ? (f.isSection ? sectionRows : placeRows) : units;
  rowData = f.badRange ? [] : base.filter(r => {
    const value = f.rangeKind === 'rate' ? rate(r, f.k) : r[f.k];
    if (lvl === 'mun') {
      if (f.zone && r.zone !== Number(f.zone)) return false;
      if (f.neighborhood && r.neighborhood !== f.neighborhood) return false;
      if (f.section && !r.sectionIds.some(s => s === Number(f.section))) return false;
      if (f.query && !normal(r.name + ' ' + r.address + ' ' + r.neighborhood).includes(f.query)) return false;
    } else if (f.query && !normal(r.name + ' ' + r.id).includes(f.query)) {
      return false;
    }
    if (f.low !== null && (value === null || value === undefined || value < f.low)) return false;
    if (f.high !== null && (value === null || value === undefined || value > f.high)) return false;
    return true;
  });
  sortRows(rowData, $('sort').value, f.k);
  filtered = lvl === 'mun' && f.isSection ? aggregate(rowData) : rowData;

  const unitWord = lvl === 'br' ? 'UFs' : lvl === 'uf' ? 'municípios' : f.isSection ? 'seções' : 'locais';
  $('range-note').textContent = f.badRange
    ? 'Faixa inválida: use valores não negativos e mínimo menor ou igual ao máximo.'
    : `${m.name}: faixa aplicada por ${lvl === 'mun' ? (f.isSection ? 'seção' : 'local') : unitWord.replace(/s$/, '')}, ${f.rangeKind === 'rate' ? 'percentual ' + baseLabel(m) : 'quantidade'}.${f.isSection ? ' Os pontos somam apenas os BUs selecionados.' : ''}`;

  const sum = filtered.reduce((a, r) => a + (r[f.k] || 0), 0);
  const stats = [`<span><b>${fmt(filtered.length)}</b> de ${fmt(units.length)} ${lvl === 'mun' ? 'locais' : unitWord}</span>`, `<span><b>${fmt(filtered.reduce((a, r) => a + r.sections, 0))}</b> BUs</span>`, `<span><b>${fmt(sum)}</b> ${esc(m.short.toLowerCase())}</span>`];
  if (lvl === 'mun') {
    const unmapped = filtered.filter(p => !plotted(p));
    stats.push(`<span><b>${fmt(unmapped.length)}</b> locais sem ponto no mapa (${fmt(unmapped.reduce((a, p) => a + p[f.k], 0))} ${esc(m.short.toLowerCase())})</span>`);
  }
  $('filter-stats').innerHTML = stats.join('');

  drawMap(f, m);
  renderList(f, m);
  renderDetail();
  $('fit').disabled = !filtered.length;
  window.ATLAS_QA.renders++;
}

function drawMap(f, m) {
  const lvl = level(), view = state.view;
  markers.clearLayers();
  if (heat) { map.removeLayer(heat); heat = null; }
  const maxCount = Math.max(1, ...units.map(u => u[f.k] || 0));
  if (lvl !== 'mun') {
    const rates = units.map(u => rate(u, f.k)).filter(v => v !== null);
    const maxRate = Math.max(0, ...rates);
    const visible = new Set(filtered.map(u => u.id));
    const byId = new Map(units.map(u => [u.id, u]));
    for (const [id, layer] of areaByUnit) {
      const u = byId.get(id);
      const r = u ? rate(u, f.k) : null;
      const shown = u && visible.has(id);
      layer.setStyle({fillColor: view === 'choro' && shown && r !== null ? color(maxRate > 0 ? r / maxRate : 0) : '#2a3b52', fillOpacity: shown ? (view === 'choro' ? .72 : .25) : .08});
      layer.unbindTooltip();
      if (u) layer.bindTooltip(`${esc(u.name)}<br>${esc(m.name)}: ${fmt(u[f.k])}<br>${pct(r)} ${esc(baseLabel(m))}`, {sticky: true});
      const el = layer.getElement && layer.getElement();
      if (el && u) el.setAttribute('aria-label', `${u.name}; ${m.name}: ${fmt(u[f.k])}; ${pct(r)}; abrir`);
    }
    if (view === 'count') {
      for (const u of filtered) {
        const layer = areaByUnit.get(u.id);
        if (!layer || !u[f.k]) continue;
        L.circleMarker(layer.getBounds().getCenter(), {radius: 3 + 20 * Math.sqrt(u[f.k] / maxCount), weight: 1, color: '#16394b', fillColor: color(u[f.k] / maxCount), fillOpacity: .85})
          .bindTooltip(`${esc(u.name)}<br>${esc(m.name)}: ${fmt(u[f.k])}`, {direction: 'top'})
          .on('click', () => drill(u.id)).addTo(markers);
      }
    }
    $('legend-title').textContent = `${m.name}: ${view === 'choro' ? 'percentual ' + baseLabel(m) : 'contagem por ' + (lvl === 'br' ? 'UF' : 'município')}`;
    $('legend-start').textContent = view === 'choro' ? '0%' : '0';
    $('legend-end').textContent = view === 'choro' ? pct(maxRate) : fmt(maxCount);
    $('legend-help').textContent = view === 'choro'
      ? `Escala de 0 até a maior taxa entre as ${lvl === 'br' ? 'UFs' : 'cidades do estado'} (${pct(maxRate)}), fixa para o indicador; filtros não mudam a escala. Áreas apagadas ficaram fora dos filtros. Clique em uma área para abrir.`
      : `Círculos no centro de cada área; maiores representam mais registros. Referência máxima fixa: ${fmt(maxCount)}. Clique para abrir.`;
    window.ATLAS_QA.drawn = {areas: areaByUnit.size, markers: markers.getLayers().length};
    return;
  }
  const mapped = filtered.filter(plotted);
  if (view === 'heat' && mapped.length) {
    const points = mapped.filter(p => p[f.k] > 0).map(p => [p.lat, p.lon, p[f.k] / maxCount]);
    if (points.length) heat = L.heatLayer(points, {radius: 23, blur: 18, maxZoom: 12, max: 1, minOpacity: .12, gradient: {.15: PALETTE[0], .35: PALETTE[1], .55: PALETTE[2], .75: PALETTE[3], 1: PALETTE[4]}}).addTo(map);
  }
  for (const p of mapped) {
    const r = rate(p, f.k);
    const t = view === 'rate' ? (r ?? 0) / 100 : p[f.k] / maxCount;
    const zero = p[f.k] === 0;
    const marker = L.circleMarker([p.lat, p.lon], {
      radius: view === 'heat' ? 4.8 : view === 'rate' ? 8 : 3 + 20 * Math.sqrt(p[f.k] / maxCount),
      weight: 1, color: view === 'heat' ? '#17334d' : '#16394b',
      fillColor: zero ? '#68768a' : view === 'heat' ? '#f5f9ff' : color(t), fillOpacity: zero ? 0 : view === 'heat' ? .65 : .82,
    });
    marker.bindTooltip(`${esc(p.name)}<br>${esc(m.name)}: ${fmt(p[f.k])} (${pct(r)} ${esc(baseLabel(m))})`, {direction: 'top'});
    marker.on('click', () => selectRow(p, false));
    marker.addTo(markers);
    const el = marker.getElement();
    if (el) {
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `${p.name}; ${m.name}: ${fmt(p[f.k])}; abrir ficha`);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); selectRow(p, false); } });
    }
  }
  $('legend-title').textContent = `${m.name}: ${view === 'heat' ? 'intensidade visual relativa dos pontos' : view === 'rate' ? 'percentual ' + baseLabel(m) : 'contagem por local'}`;
  $('legend-start').textContent = view === 'heat' ? 'Menor intensidade' : view === 'rate' ? '0%' : '0';
  $('legend-end').textContent = view === 'heat' ? 'Maior intensidade' : view === 'rate' ? '100%' : fmt(maxCount);
  $('legend-help').textContent = view === 'heat'
    ? 'Calor relativo: manchas podem se sobrepor. Pontos brancos são locais consultáveis; círculos vazados indicam zero. Valores zero não geram calor. Escala por indicador; não comparar cores entre indicadores.'
    : view === 'rate' ? 'Círculos de tamanho fixo; cor em escala de 0 a 100%. Consulte a taxa exata no ponto.'
      : `Círculos maiores representam mais registros. Referência máxima fixa do município: ${fmt(maxCount)} por local; filtros não alteram essa referência.`;
  window.ATLAS_QA.drawn = {areas: 0, markers: markers.getLayers().length, heat: heat ? heat._latlngs.length : 0};
}

function listColumns(lvl) {
  const o = state.office;
  const tail = [['aptos', 'Aptos'], ['comp', 'Comparec.'], ['abst', 'Abstenções'], [o + '.blank', 'Brancos'], [o + '.null', 'Nulos'], [o + '.valid', 'Válidos'], [upKey(), 'UP']];
  if (lvl === 'mun') return {head: ['Local de votação', 'Zona / local / seção', 'Bairro cadastral', 'BUs'], tail: [...tail, ['status', 'No mapa']]};
  return {head: [lvl === 'br' ? 'UF' : 'Município', lvl === 'br' ? 'Municípios' : 'Locais', 'BUs'], tail};
}

function rowKey(r) {
  if (level() !== 'mun') return r.id;
  return r.kind === 'section' ? `s${r.zone}-${r.section}` : `p${r.idx}`;
}

function renderList(f, m) {
  const lvl = level(), cols = listColumns(lvl);
  const pages = Math.max(1, Math.ceil(rowData.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const slice = rowData.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  $('places-head').innerHTML = `<tr>${cols.head.map(h => `<th>${h}</th>`).join('')}<th>${esc(m.short)}</th><th>% ${esc(baseLabel(m))}</th>${cols.tail.map(([, h]) => `<th>${h}</th>`).join('')}</tr>`;
  const width = cols.head.length + 2 + cols.tail.length;
  const statusText = s => s === 1 ? 'sim' : s === 3 ? 'sim (conferido na UF)' : s === 2 ? 'fora do município' : 'sem coordenada';
  $('places-body').innerHTML = slice.map(r => {
    const key = esc(rowKey(r));
    const lead = lvl === 'mun'
      ? `<td><button class="row-button" data-row="${key}">${esc(r.name)}${r.kind === 'section' ? ' (seção ' + r.section + ')' : ''}</button></td><td>${r.zone} / ${r.local}${r.kind === 'section' ? ' / ' + r.section : ''}</td><td>${esc(r.neighborhood)}</td><td>${fmt(r.sections)}</td>`
      : `<td><button class="row-button" data-row="${key}">${esc(r.name)}</button></td><td>${fmt(lvl === 'br' ? r.munis : r.places)}</td><td>${fmt(r.sections)}</td>`;
    const rest = cols.tail.map(([k]) => k === 'status' ? `<td>${statusText(r.status)}</td>` : `<td>${fmt(r[k])}</td>`).join('');
    return `<tr>${lead}<td>${fmt(r[f.k])}</td><td>${pct(rate(r, f.k))}</td>${rest}</tr>`;
  }).join('') || `<tr><td colspan="${width}" class="empty">Nenhum registro corresponde aos filtros. Use "Limpar filtros".</td></tr>`;
  const word = lvl === 'br' ? 'UFs' : lvl === 'uf' ? 'municípios' : f.isSection ? 'seções' : 'locais';
  $('places-caption').textContent = `${fmt(rowData.length)} ${word} - ${m.name} - ordenação: ${$('sort').selectedOptions[0].textContent} - mapa e lista compartilham os filtros`;
  $('list-summary').textContent = `Lista filtrada: ${word}`;
  const pager = pages > 1
    ? `<span class="small">Página ${state.page + 1} de ${pages} (${fmt(rowData.length)} registros; totais acima somam toda a seleção)</span><button type="button" data-page="-1"${state.page === 0 ? ' disabled' : ''}>Anterior</button><button type="button" data-page="1"${state.page >= pages - 1 ? ' disabled' : ''}>Próxima</button>`
    : '';
  $('pager-top').innerHTML = pager;
  $('pager-bottom').innerHTML = pager;
}

function selectRow(r, pan) {
  if (level() !== 'mun') return drill(r.id);
  state.selected = rowKey(r);
  renderDetail();
  if (pan && plotted(r)) {
    const m = metric();
    map.setView([r.lat, r.lon], Math.max(map.getZoom(), 15));
    L.popup().setLatLng([r.lat, r.lon]).setContent(`<strong>${esc(r.name)}</strong><br>${esc(m.name)}: <b>${fmt(r[m.key])}</b><br>${pct(rate(r, m.key))} ${esc(baseLabel(m))}`).openOn(map);
  }
}

function renderDetail() {
  const lvl = level(), m = metric();
  const tiles = metricList().filter(x => KEYS.includes(x.key) || ['abst', 'comp', 'aptos'].includes(x.key));
  const numbers = obj => `<div class="detail-numbers">${tiles.map(x => `<div>${esc(x.short)}<strong>${fmt(obj[x.key])}</strong>${x.key === 'aptos' && lvl === 'mun' && obj !== territory ? '' : pct(rate(obj, x.key)) + ' ' + esc(baseLabel(x))}</div>`).join('')}</div>`;
  if (lvl !== 'mun' || !state.selected) {
    const hint = lvl === 'mun' ? 'Clique em um ponto ou no nome do local na tabela para abrir a ficha.' : `Clique em ${lvl === 'br' ? 'um estado' : 'um município'} no mapa ou na tabela para abrir o recorte.`;
    $('detail').innerHTML = `<div class="over">Recorte atual</div><h3 style="margin-top:15px">${esc(territoryName())}</h3><p class="small">${hint}</p>${numbers(territory)}<div class="note small">${lvl === 'mun' ? 'O ponto é uma localização administrativa. Abstenção é a contagem de ausências vinculadas às seções daquele local, não a localização das pessoas ausentes.' : 'As áreas são malhas do IBGE. A cor compara taxas entre unidades do mesmo nível, não densidade de eleitores.'}</div>`;
    return;
  }
  const r = rowData.find(x => rowKey(x) === state.selected) || filtered.find(x => rowKey(x) === state.selected);
  if (!r) {
    state.selected = null;
    map.closePopup();
    return renderDetail();
  }
  const ids = new Set(r.sectionIds);
  const secs = sectionRows.filter(s => s.place === r.idx && ids.has(s.section)).sort((a, b) => a.section - b.section);
  const coord = r.lat !== null && r.lon !== null
    ? `<a href="https://www.google.com/maps/search/?api=1&query=${r.lat}%2C${r.lon}" target="_blank" rel="noopener">Ver esta coordenada no Google Maps</a><p class="small" style="margin-top:10px">Coordenada do cadastro TSE: ${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}${r.status === 2 ? ' (fora do município na malha IBGE; não desenhada no mapa)' : ''}.</p>`
    : '<p class="small">Sem coordenada no cadastro TSE; o local não aparece no mapa, mas está na lista e nos totais.</p>';
  $('detail').innerHTML = `<div class="over">Zona ${r.zone} - local ${r.local}${r.kind === 'section' ? ' - seção ' + r.section : ''}</div><h3 style="margin-top:13px">${esc(r.name)}</h3><p class="small">${esc(r.address)}<br>${esc(r.neighborhood)} - ${esc(MUN.name)}/${esc(state.uf)}</p><div class="status">${fmt(r[m.key])} ${esc(m.short.toLowerCase())}: ${pct(rate(r, m.key))} ${esc(baseLabel(m))}</div>${numbers(r)}<p class="small">${r.sections} BUs incluídos nesta ficha (respeita os filtros).</p>${coord}<details><summary>Boletins por seção (${secs.length})</summary><div class="table-box"><table><caption>${esc(m.name)} por seção primária</caption><thead><tr><th>Seção</th><th>Contagem</th><th>Taxa</th></tr></thead><tbody>${secs.map(s => `<tr><td>${s.section}</td><td>${fmt(s[m.key])}</td><td>${pct(rate(s, m.key))}</td></tr>`).join('')}</tbody></table></div><p class="small">Seções secundárias, quando existentes, estão incluídas no BU primário; não há desagregação artificial.</p></details>`;
}

function renderTerritoryTables() {
  const lvl = level(), k = state.metric, m = metric(k), up = upKey();
  if (lvl !== 'mun') {
    $('territory-tables').innerHTML = `<p class="small">No nível ${lvl === 'br' ? 'nacional' : 'estadual'}, a lista do explorador já traz ${lvl === 'br' ? 'todas as UFs' : 'todos os municípios'} com os mesmos números. Abra um município para comparar zonas eleitorais e bairros cadastrais dos locais.</p>`;
    return;
  }
  const group = field => {
    const g = new Map();
    for (const p of placeRows) {
      const key = p[field];
      if (!g.has(key)) {
        const a = {label: key, places: 0, sections: 0};
        for (const c of KEYS) a[c] = 0;
        g.set(key, a);
      }
      const a = g.get(key);
      a.places++;
      a.sections += p.sections;
      for (const c of KEYS) a[c] += p[c];
    }
    return [...g.values()];
  };
  const cells = x => `<td>${fmt(x.aptos)}</td><td>${fmt(x.comp)}</td><td>${fmt(x.abst)}<br><small>${pct(rate(x, 'abst'))}</small></td><td>${fmt(x[k])}<br><small>${pct(rate(x, k))}</small></td><td>${fmt(x[up])}<br><small>${pct(rate(x, up))}</small></td><td>${fmt(x[state.office + '.blank'])}</td><td>${fmt(x[state.office + '.null'])}</td>`;
  const head = `<th>Aptos</th><th>Comparec.</th><th>Abstenções</th><th>${esc(m.short)}</th><th>UP</th><th>Brancos</th><th>Nulos</th>`;
  const zones = group('zone').sort((a, b) => a.label - b.label);
  const hoods = group('neighborhood').sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  $('territory-tables').innerHTML = `<div class="grid-two"><article class="panel"><h3>Zona não é região urbana</h3><p class="small">Zonas são unidades eleitorais. Não há polígonos fictícios para transformá-las em "norte", "sul" ou bairros.</p></article><article class="panel"><h3>Bairro do prédio, não do eleitor</h3><p class="small">A comparação por bairro agrupa os locais pelo rótulo cadastral do TSE. Ela descreve onde os votos foram registrados, não o voto dos moradores de cada bairro.</p></article></div>
<h3 style="margin-top:22px">${zones.length} zonas: totais e participação</h3><div class="table-box"><table><caption>${esc(MUN.name)} completo. Candidaturas: percentual dos válidos. Abstenção: percentual dos aptos.</caption><thead><tr><th>Zona</th>${head}</tr></thead><tbody id="zones-body">${zones.map(x => `<tr><td>${x.label}<br><small>${x.sections} BUs</small></td>${cells(x)}</tr>`).join('')}</tbody></table></div>
<details><summary>Comparação pelos ${hoods.length} rótulos de bairro dos locais</summary><p class="small">Grafia mantida conforme o cadastro. Rótulos não foram fundidos por semelhança de nome. Não é um mapa de limites de bairros.</p><div class="table-box"><table><caption>Município completo, bairros em ordem alfabética</caption><thead><tr><th>Bairro do local</th><th>Locais</th>${head}</tr></thead><tbody id="neighborhoods-body">${hoods.map(x => `<tr><td>${esc(x.label)}</td><td>${x.places}</td>${cells(x)}</tr>`).join('')}</tbody></table></div></details>`;
}

function renderCandidates() {
  const lvl = level(), o = office(), valid = territory[state.office + '.valid'];
  let rows;
  if (state.office === 1) {
    rows = META.president.map(c => ({name: `${c.name} (${c.party})`, n: c.n, votes: territory['1.' + c.n]}));
    $('candidates-intro').textContent = 'Candidaturas acompanhadas pelo atlas: Lula, Flávio Bolsonaro e Samara (UP). As demais entram nos votos válidos, mas não são exibidas.';
  } else if (lvl === 'br') {
    rows = units.filter(u => u[upKey()] !== null).map(u => ({name: `UP em ${u.name}`, n: '80', votes: u[upKey()], den: u[state.office + '.valid']}));
    $('candidates-intro').textContent = `Votos da UP para ${o.name} em cada UF (candidaturas + legenda). Escolha um estado para ver cada candidatura.`;
  } else {
    rows = ((META.up[state.uf] || {})[state.office] || []).map(v => ({name: v.kind === 'legenda' ? 'Legenda UP (80)' : v.name, n: v.n, votes: territory[state.office + '.' + v.n]}));
    $('candidates-intro').textContent = `Candidaturas válidas da UP e voto de legenda para ${o.name} em ${ufName(state.uf)}.`;
  }
  rows.sort((a, b) => (b.votes || 0) - (a.votes || 0) || a.name.localeCompare(b.name, 'pt-BR'));
  $('candidates-summary').textContent = state.office === 1 ? 'Candidaturas presidenciais no recorte' : `Unidade Popular: ${o.name}`;
  $('candidates-caption').textContent = `${territoryName()} - ${rows.length} linhas`;
  $('candidates-body').innerHTML = rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.n)}</td><td>${fmt(r.votes)}</td><td>${pct((r.den ?? valid) > 0 && r.votes !== null ? 100 * r.votes / (r.den ?? valid) : null)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">A UP não teve candidatura válida para este cargo neste estado.</td></tr>';
}

function renderStatic() {
  const c = META.coverage, checks = META.checks;
  const plottedCount = (c.places_status_1 || 0) + (c.places_status_3 || 0), outside = c.places_status_2 || 0, missing = c.places_status_0 || 0;
  $('method-data').innerHTML = [
    `${fmt(c.sections)} boletins primários (seções com resultado) agrupados em ${fmt(c.places)} locais de votação.`,
    `${fmt(c.secondary)} seções secundárias agregadas a primárias no cadastro, sem inventar resultados separados.`,
    `${fmt(plottedCount)} locais com coordenada conferida contra a malha municipal; ${fmt(outside)} com coordenada fora do município e ${fmt(missing)} sem coordenada, mantidos na lista e nos totais.`,
    'Malhas do IBGE: UFs e municípios. Sem polígonos de zona ou bairro inventados.',
    ...META.missing_mesh.map(m => `Sem malha municipal: ${m}. Os locais desse município foram conferidos só contra a malha da UF.`),
    'Presidente: Lula, Flávio Bolsonaro e Samara (UP); as demais candidaturas entram só nos válidos. Demais cargos: somente a Unidade Popular, com válidos, brancos e nulos como denominadores.',
  ].map(t => `<li>${esc(t)}</li>`).join('');
  $('method-checks').innerHTML = [
    `${fmt(checks.comparisons)} comparações com as totalizações oficiais do TSE (nacional, cada UF e cada cargo); ${fmt(checks.failed)} divergências.`,
    `Invariantes por seção (comparecimento + abstenções = aptos; válidos + brancos + nulos = comparecimento x votos por eleitor): ${Object.keys(checks.invariant_violations).length ? 'ver relatório' : 'nenhuma violação'}.`,
    'Candidaturas: votos / válidos do cargo. Brancos, nulos e válidos: contagem / votos do cargo (igual ao comparecimento quando há um voto por eleitor).',
    'Abstenções e comparecimento: contagem / aptos. Taxas agregadas são razões entre somas, nunca médias de percentuais.',
    'Não foi realizada validação criptográfica das assinaturas dos boletins ou dos arquivos JWS.',
  ].map(t => `<li>${esc(t)}</li>`).join('');
  const sources = META.sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.description)}</a>: ${s.last_modified ? 'publicado em ' + esc(s.last_modified) + '; ' : ''}baixado em ${esc(s.fetched_at)}; SHA-256 <code>${esc(s.sha256.slice(0, 16))}...</code></li>`);
  sources.push(`<li>Mais ${fmt(META.source_counts.feeds - 1)} totalizações do TSE por UF e cargo (resultados.tse.jus.br) e ${fmt(META.source_counts.meshes - 1)} malhas municipais do IBGE (servicodados.ibge.gov.br), com hash no manifesto do pipeline.</li>`);
  $('sources').innerHTML = sources.join('');
  $('footer').textContent = `Dados gerados em ${new Date(META.generated_at).toLocaleString('pt-BR')} pelo pipeline determinístico. Visualização informativa com dados agregados, sem recomendações de abordagem eleitoral.`;
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const officeCode = Number(p.get('cargo'));
  if (META.offices.some(o => o.code === officeCode)) state.office = officeCode;
  state.metric = p.get('indicador') || '';
  state.view = p.get('vis') || '';
  return {uf: META.ufs.some(u => u.uf === p.get('uf')) ? p.get('uf') : '', mun: p.get('mun') || ''};
}

function writeHash() {
  const p = new URLSearchParams();
  p.set('cargo', state.office);
  if (state.uf) p.set('uf', state.uf);
  if (state.mun) p.set('mun', state.mun);
  p.set('indicador', state.metric);
  p.set('vis', state.view);
  history.replaceState(null, '', '#' + p.toString());
}

function expand(force) {
  const on = force === undefined ? !$('atlas').classList.contains('map-expanded') : force;
  $('atlas').classList.toggle('map-expanded', on);
  $('expand').textContent = on ? 'Fechar ampliação' : 'Ampliar mapa';
  $('expand').setAttribute('aria-pressed', String(on));
  document.body.style.overflow = on ? 'hidden' : '';
  setTimeout(() => map.invalidateSize(), 50);
}

function bind() {
  $('office').addEventListener('change', () => {
    state.office = Number($('office').value);
    state.metric = '';
    refreshMetricOptions();
    syncTerritoryControls();
    renderAll();
    writeHash();
  });
  $('uf').addEventListener('change', () => navigate($('uf').value, ''));
  $('mun').addEventListener('change', () => navigate(state.uf, $('mun').value));
  $('crumbs').addEventListener('click', e => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    const [uf, mun] = b.dataset.go.split('|');
    navigate(uf, mun || '');
  });
  $('share').addEventListener('click', async () => {
    writeHash();
    try {
      await navigator.clipboard.writeText(location.href);
      $('share').textContent = 'Link copiado';
    } catch {
      $('share').textContent = 'Copie o endereço da barra';
    }
    setTimeout(() => { $('share').textContent = 'Copiar link deste recorte'; }, 2500);
  });
  for (const id of ['metric', 'view', 'zone', 'neighborhood', 'unit', 'range-kind', 'sort']) {
    $(id).addEventListener('change', () => {
      if (id === 'metric') state.metric = $('metric').value;
      if (id === 'view') state.view = $('view').value;
      if (id === 'unit' && $('unit').value === 'place') $('section-filter').value = '';
      state.page = 0;
      map.closePopup();
      if (id === 'metric') { renderHeader(); renderTerritoryTables(); }
      render();
      writeHash();
    });
  }
  $('query').addEventListener('input', () => { state.page = 0; map.closePopup(); render(); });
  for (const id of ['min-value', 'max-value', 'section-filter']) {
    $(id).addEventListener('input', () => {
      if (id === 'section-filter' && $(id).value) $('unit').value = 'section';
      state.page = 0;
      map.closePopup();
      render();
    });
  }
  const pageClick = e => {
    const b = e.target.closest('[data-page]');
    if (!b) return;
    state.page += Number(b.dataset.page);
    render();
  };
  $('pager-top').addEventListener('click', pageClick);
  $('pager-bottom').addEventListener('click', pageClick);
  $('places-body').addEventListener('click', e => {
    const b = e.target.closest('[data-row]');
    if (!b) return;
    const r = rowData.find(x => String(rowKey(x)) === b.dataset.row);
    if (!r) return;
    selectRow(r, true);
    if (level() === 'mun') $('map').scrollIntoView({behavior: reduceMotion() ? 'instant' : 'smooth', block: 'center'});
  });
  $('fit').addEventListener('click', () => {
    if (!filtered.length) return;
    if (level() === 'mun') {
      const pts = filtered.filter(plotted).map(p => [p.lat, p.lon]);
      if (pts.length) map.fitBounds(L.latLngBounds(pts), {padding: [30, 30], maxZoom: 15});
      return;
    }
    const layers = filtered.map(u => areaByUnit.get(u.id)).filter(Boolean);
    if (layers.length) map.fitBounds(L.featureGroup(layers).getBounds(), {padding: [10, 10]});
  });
  $('frame').addEventListener('click', frameTerritory);
  $('reset').addEventListener('click', () => { clearFilters(); render(); frameTerritory(); });
  $('expand').addEventListener('click', () => expand());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') expand(false); });
  window.addEventListener('hashchange', () => {
    const target = readHash();
    if (target.uf !== state.uf || target.mun !== state.mun) setTerritory(target.uf, target.mun);
  });
}

window.ATLAS_QA = {
  ready: false, renders: 0, errors: [], drawn: {},
  state: () => ({...state, level: level()}),
  territory: () => territory,
  units: () => units.length,
  list: () => rowData.length,
  filtered: () => filtered.length,
  sum: key => filtered.reduce((a, r) => a + (r[key || state.metric] || 0), 0),
  metrics: () => metricList().map(m => m.key),
  tiles: () => ({loaded: tilesLoaded, failed: tilesFailed}),
  map,
};

(async function init() {
  setLoading(true);
  try {
    [META, BR, GEO_BR] = await Promise.all([load('meta.json'), load('br.json'), load('geo/br.json')]);
    $('uf').innerHTML = '<option value="">Brasil inteiro</option>' + META.ufs.map(u => `<option value="${u.uf}">${esc(u.name)}</option>`).join('');
    renderStatic();
    bind();
    const target = readHash();
    await setTerritory(target.uf, target.mun);
    writeHash();
    window.ATLAS_QA.ready = true;
  } catch (error) {
    $('filter-stats').textContent = 'Não foi possível carregar os dados do atlas: ' + error.message;
    window.ATLAS_QA.errors.push(String(error));
  } finally {
    setLoading(false);
  }
})();
