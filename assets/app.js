'use strict';
// Todo texto externo inserido em markup passa por esc(); números vêm do dataset validado pelo pipeline.
const $ = id => document.getElementById(id);
const fmt = n => n === null || n === undefined ? 'n/d' : Number(n).toLocaleString('pt-BR');
const pct = n => n === null || !Number.isFinite(n) ? 'não calculável' : n.toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + '%';
const pp = n => n === null || !Number.isFinite(n) ? 'não calculável' : (n > 0 ? '+' : '') + n.toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' p.p.';
const signed = n => n === null || n === undefined ? 'n/d' : (n > 0 ? '+' : '') + fmt(n);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const normal = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const PALETTE = ['#4057bd', '#39bcde', '#53d5af', '#f5de65', '#ef665f'];
const DIVERGING = ['#2f6fe0', '#7fa7ee', '#c9d2de', '#f19a8f', '#e0453a'];
const ZERO_COLOR = '#dfe6ee';
const NO_DATA = '#2a3b52';
const MIN_CORR_UNITS = 25;
const MAX_CORR_CANDIDATES = 8;
const OFFICE_ABBR = {1: 'Pres.', 3: 'Gov.', 5: 'Sen.', 6: 'Dep. Fed.', 7: 'Dep. Est.'};
const PAGE_SIZE = 100;
const BRAZIL_VIEW = [[-33.8, -74], [5.3, -34.8]];
const color = t => PALETTE[Math.min(4, Math.max(0, Math.floor(t * 5)))];
const CHANGE = ['#d9622b', '#eda57f', '#c9d2de', '#7fd3c4', '#1fa88f'];
const divColor = (t, ramp = DIVERGING) => ramp[Math.min(4, Math.max(0, Math.floor((t + 1) / 2 * 5)))];
const PAST_KINDS = ['past', 'change'];
const plotted = p => p.status === 1 || p.status === 3;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {office: 1, uf: '', mun: '', metric: '', view: '', page: 0, selected: null};
const requests = new Map();
let META, BR, GEO_BR;
let UF = null, GEO_UF = null, MUN = null;
let KEYS = [], SUM_KEYS = [], zoneSections = new Map(), units = [], territory = {}, places = [], placeRows = [], sectionRows = [];
let rowData = [], filtered = [], areaLayer = null, areaByUnit = new Map(), heat = null;
let tilesLoaded = 0, tilesFailed = 0;
let zoneGeometry = null, zoneRowsDrawn = new Map(), corrState = null;

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
const hasBlocs = code => META.blocs.offices.includes(code);
const votables = (uf, code) => (META.votables[uf] || {})[code] || [];
const occupancyKeys = cols => Object.values(META.occupancy).flat().filter(k => cols.includes(k));

function leftTip() {
  const parties = META.blocs.left.map(p => p.party);
  return `Campo da esquerda: soma dos votos nas candidaturas válidas de ${parties.slice(0, -1).join(', ')} e ${parties.at(-1)} para o cargo. Conta o partido de cada candidatura, não a coligação: candidaturas de outros partidos apoiadas por eles não entram. PL: candidaturas válidas do PL (22). Esquerda x PL: diferença entre os dois, em pontos percentuais dos votos válidos.`;
}
const tip = text => `<button type="button" class="tip" aria-label="${esc(text)}" data-tip="${esc(text)}">?</button>`;

function toObjects(cols, rows, offset, head, isSection) {
  const offices = META.offices.map(o => o.code);
  const occ = isSection ? occupancyKeys(cols) : [];
  return rows.map(r => {
    const o = head(r);
    cols.forEach((c, i) => { o[c] = r[offset + i]; });
    for (const code of offices) {
      if (cols.includes(code + '.blank')) {
        const blank = o[code + '.blank'], nulls = o[code + '.null'];
        o[code + '.bn'] = blank === null || nulls === null ? null : blank + nulls;
      }
      if (cols.includes(code + '.left')) {
        const left = o[code + '.left'], pl = o[code + '.pl'];
        o[code + '.margin'] = left === null || pl === null ? null : left - pl;
      }
    }
    for (const k of occ) o[k + '#s'] = o[k] === null || o[k] === undefined ? null : o[k] > 0 ? 1 : 0;
    return o;
  });
}

const upNow = code => code === 1 ? '1.80' : code + '.up';
const prevYear = () => META.previous.year;
const hadUpNow = (uf, code) => code === 1 || votables(uf, code).some(v => v.group === 'up');

function deriveChange(o, uf) {
  for (const {code} of META.offices) {
    const before = o[code + '.up22'];
    if (before === undefined) continue;
    const now = o[upNow(code)];
    o[code + '.chg'] = before !== null && now !== null && now !== undefined && (!uf || hadUpNow(uf, code)) ? now - before : null;
  }
  return o;
}

function withDerived(cols, isSection) {
  const derived = [];
  for (const o of META.offices) {
    if (cols.includes(o.code + '.blank')) derived.push(o.code + '.bn');
    if (cols.includes(o.code + '.left')) derived.push(o.code + '.margin');
    if (cols.includes(o.code + '.up22')) derived.push(o.code + '.chg');
  }
  if (isSection) derived.push(...occupancyKeys(cols).map(k => k + '#s'));
  return [...cols, ...derived];
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

function metricList(code) {
  const o = code ?? state.office;
  const list = [];
  const add = (key, name, short, kind, group, extra) => list.push({key, name, short, kind, group, office: o, ...extra});
  if (o === 1) {
    for (const c of META.president) add('1.' + c.n, `${c.name} (${c.party} ${c.n})`, c.name, 'cand', 'Candidaturas');
  } else {
    add(o + '.up', hasBlocs(o) ? 'UP no cargo' : 'UP no cargo (candidaturas + legenda)', 'UP no cargo', 'cand', 'Candidaturas');
    if (level() !== 'br') {
      for (const v of votables(state.uf, o)) {
        const legenda = v.kind === 'legenda';
        add(o + '.' + v.n, legenda ? 'Legenda UP (80)' : `${v.name} (${v.party} ${v.n})`, legenda ? 'Legenda UP' : v.name, 'cand', 'Candidaturas', {party: v.party, bloc: v.group});
      }
    }
  }
  if (hasBlocs(o)) {
    add(o + '.left', 'Campo da esquerda', 'Campo da esquerda', 'cand', 'Blocos', {tip: true});
    if (o !== 1) add(o + '.pl', 'PL (22)', 'PL', 'cand', 'Blocos', {tip: true});
    add(o + '.margin', 'Esquerda x PL (diferença)', 'Esquerda x PL', 'margin', 'Blocos', {tip: true});
  }
  add(o + '.valid', 'Votos válidos', 'Válidos', 'vote', 'Votos do cargo');
  add(o + '.bn', 'Brancos e nulos', 'Brancos e nulos', 'vote', 'Votos do cargo');
  add(o + '.blank', 'Brancos', 'Brancos', 'vote', 'Votos do cargo');
  add(o + '.null', 'Nulos', 'Nulos', 'vote', 'Votos do cargo');
  if (KEYS.includes(o + '.up22')) {
    const year = prevYear();
    add(o + '.up22', `UP em ${year}`, `UP ${year}`, 'past', `Comparação com ${year}`);
    add(o + '.chg', `UP: variação ${year} x 2026`, `Variação desde ${year}`, 'change', `Comparação com ${year}`);
  }
  for (const k of META.occupancy[o] || []) {
    const base = list.find(m => m.key === k) || {short: k === o + '.pl' ? 'PL' : k};
    add(k + '#s', `Ocupação de urnas: ${base.short}`, `Seções com voto (${base.short})`, 'occ', 'Ocupação de urnas (seções com ao menos 1 voto)', {of: k});
  }
  add('abst', 'Abstenções', 'Abstenções', 'people', 'Eleitorado');
  add('comp', 'Comparecimentos', 'Comparecimentos', 'people', 'Eleitorado');
  add('aptos', 'Eleitorado apto', 'Aptos', 'aptos', 'Eleitorado');
  return list;
}
const metric = key => metricList().find(m => m.key === (key || state.metric));

function officeVotes(obj, o) {
  const parts = [obj[o + '.valid'], obj[o + '.blank'], obj[o + '.null']];
  return parts.some(v => v === null || v === undefined) ? null : parts.reduce((a, b) => a + b, 0);
}
function denominator(obj, m) {
  if (m.kind === 'cand' || m.kind === 'margin') return obj[m.office + '.valid'];
  if (m.kind === 'vote') return officeVotes(obj, m.office);
  if (m.kind === 'occ') return obj.sections;
  if (m.kind === 'past') return obj[m.office + '.valid22'];
  if (m.kind === 'people') return obj.aptos;
  return territory.aptos;
}
function baseLabel(m) {
  if (m.kind === 'cand') return 'dos válidos';
  if (m.kind === 'margin') return 'dos válidos (esquerda menos PL)';
  if (m.kind === 'occ') return 'das seções (BUs)';
  if (m.kind === 'past') return `dos válidos de ${prevYear()}`;
  if (m.kind === 'change') return `dos válidos (2026 menos ${prevYear()})`;
  if (m.kind === 'vote') return office().votes_per_voter > 1 ? `dos votos do cargo (${office().votes_per_voter} por eleitor)` : 'dos comparecimentos';
  if (m.kind === 'people') return 'dos aptos';
  return 'dos aptos do recorte';
}
function rate(obj, key) {
  const m = metric(key);
  if (m.kind === 'change') {
    const o = m.office, now = obj[upNow(o)], valid = obj[o + '.valid'], before = obj[o + '.up22'], validBefore = obj[o + '.valid22'];
    if (obj[m.key] === null || obj[m.key] === undefined || !(valid > 0) || !(validBefore > 0)) return null;
    return 100 * (now / valid - before / validBefore);
  }
  const value = obj[m.key], den = denominator(obj, m);
  return value === null || value === undefined || !(den > 0) ? null : 100 * value / den;
}
function rateText(obj, key) {
  const m = metric(key);
  return m.kind === 'margin' || m.kind === 'change' ? pp(rate(obj, key)) : pct(rate(obj, key));
}
const countText = (obj, m) => m.kind === 'margin' || m.kind === 'change' ? signed(obj[m.key]) : fmt(obj[m.key]);

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
const zoneLayers = L.layerGroup().addTo(map);

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
    refreshMetricOptions();
    syncTerritoryControls();
    buildAreas();
    clearFilters();
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
    SUM_KEYS = KEYS;
    units = toObjects(BR.cols, BR.rows, 5, r => ({id: r[0], name: r[1], munis: r[2], places: r[3], sections: r[4]})).map(u => deriveChange(u, u.id));
    territory = deriveChange(sumRows(units, KEYS), null);
  } else if (lvl === 'uf') {
    KEYS = withDerived(UF.cols);
    SUM_KEYS = KEYS;
    units = toObjects(UF.cols, UF.rows, 6, r => ({id: r[0], ibge: r[1], name: r[2], places: r[3], sections: r[4], mapped: r[5]})).map(u => deriveChange(u, state.uf));
    territory = deriveChange(sumRows(units, KEYS), state.uf);
  } else {
    SUM_KEYS = withDerived(MUN.cols, true);
    KEYS = [...SUM_KEYS, ...withDerived(MUN.previous.cols).filter(k => !SUM_KEYS.includes(k))];
    places = MUN.places.map((p, i) => ({idx: i, zone: p[0], local: p[1], name: p[2], address: p[3], neighborhood: p[4] || 'Sem bairro no cadastro', lat: p[5], lon: p[6], status: p[7]}));
    const sections = toObjects(MUN.cols, MUN.sections, 3, r => ({zone: r[0], section: r[1], place: r[2]}), true);
    sectionRows = sections.map(s => ({...places[s.place], ...s, kind: 'section', sections: 1, sectionIds: [s.section]}));
    placeRows = aggregate(sectionRows);
    units = placeRows;
    territory = sumRows(sectionRows, SUM_KEYS);
    MUN.previous.cols.forEach((c, i) => { territory[c] = MUN.previous.total[i]; });
    deriveChange(territory, state.uf);
    zoneSections = new Map();
    for (const s of sectionRows) zoneSections.set(s.zone, (zoneSections.get(s.zone) || 0) + 1);
  }
  territory.sections = units.reduce((a, u) => a + u.sections, 0);
  zoneGeometry = null;
  corrState = null;
}

function aggregate(rows) {
  const groups = new Map();
  for (const s of rows) {
    let a = groups.get(s.place);
    if (!a) {
      a = {...places[s.place], kind: 'place', sections: 0, sectionIds: []};
      for (const k of SUM_KEYS) a[k] = 0;
      groups.set(s.place, a);
    }
    a.sections += 1;
    a.sectionIds.push(s.section);
    for (const k of SUM_KEYS) a[k] += s[k];
  }
  return [...groups.values()];
}

function aggregateZones(rows) {
  const groups = new Map();
  for (const s of rows) {
    let a = groups.get(s.zone);
    if (!a) {
      a = {kind: 'zone', zone: s.zone, name: `Zona ${s.zone}`, sections: 0, sectionIds: [], placeSet: new Set()};
      for (const k of SUM_KEYS) a[k] = 0;
      groups.set(s.zone, a);
    }
    a.sections += 1;
    a.sectionIds.push(s.section);
    a.placeSet.add(s.place);
    for (const k of SUM_KEYS) a[k] += s[k];
  }
  return [...groups.values()].map(a => withPrevious({...a, places: a.placeSet.size}));
}

function withPrevious(zone) {
  const values = MUN.previous.zones[zone.zone];
  const complete = zone.sections === zoneSections.get(zone.zone);
  MUN.previous.cols.forEach((c, i) => { zone[c] = values && complete ? values[i] : null; });
  zone.previousNote = !values ? `zona sem correspondência em ${prevYear()}` : !complete ? `filtro parcial da zona: sem comparação com ${prevYear()}` : '';
  return deriveChange(zone, state.uf);
}

const scopeLabel = o => o.code === 1 ? '' : o.scope === 'blocs' ? ' (UP, esquerda e PL)' : ' (somente UP)';

function syncTerritoryControls() {
  $('office').innerHTML = META.offices.map(o => `<option value="${o.code}"${o.code === state.office ? ' selected' : ''}${state.uf === 'ZZ' && o.code !== 1 ? ' disabled' : ''}>${esc(o.name)}${scopeLabel(o)}</option>`).join('');
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
  refreshViewOptions();
  $('metric-tip').innerHTML = hasBlocs(state.office) ? tip(leftTip()) : '';
}

function refreshViewOptions() {
  const isMun = level() === 'mun', m = state.metric && metric();
  const margin = m && (m.kind === 'margin' || m.kind === 'change');
  const past = m && PAST_KINDS.includes(m.kind);
  const zones = ['zones', 'Zonas: percentual (áreas aproximadas)'];
  const options = isMun
    ? past ? [zones] : margin ? [['rate', 'Círculos: percentual'], zones] : [['heat', 'Calor: contagem'], ['count', 'Círculos: contagem'], ['rate', 'Círculos: percentual'], zones]
    : margin ? [['choro', 'Áreas: percentual']] : [['choro', 'Áreas: percentual'], ['count', 'Círculos: contagem']];
  if (isMun) {
    if (past) $('unit').value = 'zone';
    $('unit').disabled = past;
  }
  $('view').innerHTML = options.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  const views = options.map(o => o[0]);
  state.view = views.includes(state.view) ? state.view : views[0];
  $('view').value = state.view;
}

function refreshMetricOptions() {
  const list = metricList().filter(m => KEYS.includes(m.key));
  if (!list.some(m => m.key === state.metric)) state.metric = upKey();
  const groups = [...new Set(list.map(m => m.group))];
  $('metric').innerHTML = groups.map(g => `<optgroup label="${esc(g)}">${list.filter(m => m.group === g).map(m => `<option value="${esc(m.key)}"${m.key === state.metric ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`).join('');
  refreshViewOptions();
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
  renderCorrelation();
}

function renderHeader() {
  const o = office(), name = territoryName(), lvl = level();
  $('hero-over').textContent = `${o.name}${scopeLabel(o)} - 1º turno - 04 de outubro de 2026`;
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
  const code = state.office;
  const tail = [code + '.up22', code + '.chg', upKey() + '#s', code + '.valid', code + '.blank', code + '.null'];
  let cardKeys;
  if (code === 1) {
    const top = cand.filter(m => m.group === 'Candidaturas').sort((a, b) => territory[b.key] - territory[a.key]).map(m => m.key);
    cardKeys = ['aptos', 'comp', 'abst', ...top, '1.left', '1.margin', ...tail];
  } else if (hasBlocs(code)) {
    cardKeys = ['aptos', 'comp', 'abst', upKey(), code + '.left', code + '.pl', code + '.margin', ...tail];
  } else {
    const extra = cand.filter(m => m.key !== upKey()).sort((a, b) => territory[b.key] - territory[a.key]).slice(0, 2).map(m => m.key);
    cardKeys = ['aptos', 'comp', 'abst', upKey(), ...extra, ...tail];
  }
  $('city-cards').innerHTML = cardKeys.filter(k => territory[k] !== undefined && territory[k] !== null).map(k => {
    const m = metric(k);
    const sub = k === 'aptos' ? 'Eleitorado apto no resultado' : `${rateText(territory, k)} ${baseLabel(m)}`;
    return `<div class="card"><div class="name">${esc(m.name)}${m.tip ? tip(leftTip()) : ''}</div><div class="value">${countText(territory, m)}</div><div class="sub">${esc(sub)}</div></div>`;
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
    text = `<strong>Unidade Popular, Samara (80).</strong> ${fmt(territory[key])} votos presidenciais em ${esc(territoryName())}, ${pct(rate(territory, key))} dos válidos.${sample} O indicador da UP abre selecionado; use mínimo 1 para ocultar registros sem votos. Lula, Flávio Bolsonaro e o campo da esquerda estão no seletor de indicador para comparação.`;
  } else {
    const mine = lvl === 'br' ? null : votables(state.uf, state.office).filter(v => v.group === 'up');
    const missing = mine && !mine.length ? ` A UP não teve candidatura válida a ${esc(o.name)} em ${esc(ufName(state.uf))}.` : '';
    const legenda = territory[state.office + '.80'];
    const legendaText = !hasBlocs(state.office) && legenda !== undefined && territory[key] > 0 ? ` Voto de legenda: ${fmt(legenda)}, ${pct(100 * legenda / territory[key])} dos votos da UP no cargo.` : '';
    const scope = hasBlocs(state.office)
      ? 'Para este cargo o atlas guarda a UP, as candidaturas dos partidos do campo da esquerda e as do PL; válidos, brancos e nulos servem de denominador.'
      : 'Para este cargo o atlas guarda somente a UP; válidos, brancos e nulos servem de denominador.';
    text = `<strong>Unidade Popular, ${esc(o.name)}.</strong> ${fmt(territory[key])} votos em ${esc(territoryName())}${hasBlocs(state.office) ? '' : ' (candidaturas + legenda)'}, ${pct(rate(territory, key))} dos válidos do cargo.${legendaText}${missing} ${scope}${lvl === 'br' ? ' Escolha um estado para ver cada candidatura.' : ''}`;
  }
  $('up-note').innerHTML = text + previousText() + ' As coordenadas são dos locais de votação, não dos eleitores.';
}

function previousText() {
  const code = state.office, year = prevYear(), before = territory[code + '.up22'];
  if (before === undefined) return '';
  if (before === null) {
    return level() === 'br' ? '' : ` Em ${year} a UP não teve candidatura a ${esc(office().name)} em ${esc(ufName(state.uf))}, então não há comparação.`;
  }
  const now = territory[upNow(code)];
  const senate = code === 5 ? ` No Senado, ${year} teve 1 voto por eleitor e 2026 teve 2: compare os percentuais.` : '';
  const change = territory[code + '.chg'] === null ? '' : ` Variação: ${signed(now - before)} votos, ${rateText(territory, code + '.chg')}.`;
  return ` Em ${year}: ${fmt(before)} votos, ${pct(rate(territory, code + '.up22'))} dos válidos.${change}${senate}`;
}

function readFilters() {
  const low = $('min-value').value === '' ? null : Number($('min-value').value);
  const high = $('max-value').value === '' ? null : Number($('max-value').value);
  const negativeOk = ['margin', 'change'].includes(metric().kind);
  const past = PAST_KINDS.includes(metric().kind);
  if (past && level() === 'mun') $('unit').value = 'zone';
  return {
    k: state.metric,
    zone: $('zone').value,
    neighborhood: $('neighborhood').value,
    query: normal($('query').value.trim()),
    isSection: level() === 'mun' && $('unit').value === 'section' && !past,
    isZone: level() === 'mun' && ($('unit').value === 'zone' || past),
    section: $('section-filter').value.trim(),
    rangeKind: $('range-kind').value,
    low, high,
    badRange: [low, high].some(v => v !== null && (!Number.isFinite(v) || (v < 0 && !negativeOk))) || (low !== null && high !== null && low > high),
  };
}

function sortRows(rows, order, k) {
  const value = r => order.startsWith('rate') ? rate(r, k) : r[k];
  const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR', {numeric: true}) || (a.section || 0) - (b.section || 0);
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
  const inRange = r => {
    const value = f.rangeKind === 'rate' ? rate(r, f.k) : r[f.k];
    if (f.low !== null && (value === null || value === undefined || value < f.low)) return false;
    if (f.high !== null && (value === null || value === undefined || value > f.high)) return false;
    return true;
  };
  const matches = r => {
    if (lvl !== 'mun') return !f.query || normal(r.name + ' ' + r.id).includes(f.query);
    if (f.zone && r.zone !== Number(f.zone)) return false;
    if (f.neighborhood && r.neighborhood !== f.neighborhood) return false;
    if (f.section && !r.sectionIds.some(s => s === Number(f.section))) return false;
    return !f.query || normal(r.name + ' ' + r.address + ' ' + r.neighborhood).includes(f.query);
  };
  if (f.badRange) {
    rowData = [];
    filtered = [];
  } else if (f.isZone) {
    const sections = sectionRows.filter(matches);
    rowData = aggregateZones(sections).filter(inRange);
    const kept = new Set(rowData.map(z => z.zone));
    filtered = aggregate(sections.filter(s => kept.has(s.zone)));
  } else {
    const base = lvl === 'mun' ? (f.isSection ? sectionRows : placeRows) : units;
    rowData = base.filter(r => matches(r) && inRange(r));
    filtered = f.isSection ? aggregate(rowData) : rowData;
  }
  sortRows(rowData, $('sort').value, f.k);

  const unitWord = lvl === 'br' ? 'UFs' : lvl === 'uf' ? 'municípios' : f.isZone ? 'zonas' : f.isSection ? 'seções' : 'locais';
  $('range-note').textContent = f.badRange
    ? `Faixa inválida: use ${m.kind === 'margin' ? 'números' : 'valores não negativos'} e mínimo menor ou igual ao máximo.`
    : `${m.name}: faixa aplicada por ${lvl === 'mun' ? (f.isZone ? 'zona' : f.isSection ? 'seção' : 'local') : unitWord.replace(/s$/, '')}, ${f.rangeKind === 'rate' ? 'percentual ' + baseLabel(m) : 'quantidade'}.${f.isSection || f.isZone ? ' Os pontos somam apenas os BUs selecionados.' : ''}`;

  const sum = filtered.reduce((a, r) => a + (r[f.k] || 0), 0);
  const stats = [];
  if (f.isZone) stats.push(`<span><b>${fmt(rowData.length)}</b> de ${fmt(new Set(places.map(p => p.zone)).size)} zonas</span>`);
  stats.push(`<span><b>${fmt(filtered.length)}</b> de ${fmt(units.length)} ${lvl === 'mun' ? 'locais' : unitWord}</span>`, `<span><b>${fmt(filtered.reduce((a, r) => a + r.sections, 0))}</b> BUs</span>`, `<span><b>${m.kind === 'margin' ? signed(sum) : fmt(sum)}</b> ${esc(m.short.toLowerCase())}</span>`);
  if (lvl === 'mun') {
    const unmapped = filtered.filter(p => !plotted(p));
    stats.push(`<span><b>${fmt(unmapped.length)}</b> locais sem ponto no mapa (${fmt(unmapped.reduce((a, p) => a + p[f.k], 0))} ${esc(m.short.toLowerCase())})</span>`);
  }
  $('filter-stats').innerHTML = stats.join('');

  drawMap(f, m);
  renderList(f, m);
  renderDetail();
  $('fit').disabled = !filtered.length;
  writeHash();
  window.ATLAS_QA.renders++;
}

function scaleFor(m, rates, fromMin) {
  if (m.kind === 'margin' || m.kind === 'change') {
    const max = Math.max(0, ...rates.map(Math.abs));
    const ramp = m.kind === 'change' ? CHANGE : DIVERGING;
    return {min: -max, max, fill: r => r === null ? NO_DATA : divColor(max > 0 ? r / max : 0, ramp)};
  }
  const max = Math.max(0, ...rates);
  const min = fromMin && rates.length ? Math.min(...rates) : 0;
  return {min, max, fill: r => r === null ? NO_DATA : r === 0 ? ZERO_COLOR : color(max > min ? (r - min) / (max - min) : 1)};
}

function setLegend(m, title, start, end, help) {
  $('legend-title').textContent = title;
  $('legend-start').textContent = start;
  $('legend-end').textContent = end;
  $('legend-help').textContent = help;
  $('ramp').style.background = m.kind === 'margin' || m.kind === 'change' ? `linear-gradient(90deg,${(m.kind === 'change' ? CHANGE : DIVERGING).join(',')})` : '';
}

function rateLegend(m, scale, unitWord) {
  if (m.kind === 'change') {
    const gap = scale.max.toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' p.p.';
    const senate = m.office === 5 ? ` No Senado, ${prevYear()} teve 1 voto por eleitor e 2026 teve 2: compare só os percentuais.` : '';
    return [`UP caiu ${gap}`, `UP cresceu ${gap}`, `Laranja: a UP perdeu participação nos válidos desde ${prevYear()}; verde: ganhou; cinza: variação pequena. Escala simétrica até a maior variação entre ${unitWord} (${gap}). Sem cor: sem candidatura da UP em um dos anos ou zona alterada.${senate}`];
  }
  if (m.kind === 'margin') {
    const gap = scale.max.toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' p.p.';
    return [`PL à frente ${gap}`, `Esquerda à frente ${gap}`, `Azul: PL à frente; vermelho: campo da esquerda à frente; cinza: diferença pequena. Escala simétrica até a maior diferença entre ${unitWord} (${pp(scale.max)}).`];
  }
  const from = scale.min > 0 ? `da menor (${pct(scale.min)})` : 'de 0';
  return [pct(scale.min), pct(scale.max), `Escala ${from} até a maior taxa entre ${unitWord} (${pct(scale.max)}), fixa para o indicador; filtros não mudam a escala. Cinza-claro: zero voto confirmado; azul-escuro apagado: sem dado.`];
}

function drawMap(f, m) {
  const lvl = level(), view = state.view;
  markers.clearLayers();
  zoneLayers.clearLayers();
  if (heat) { map.removeLayer(heat); heat = null; }
  const maxCount = Math.max(1, ...units.map(u => Math.abs(u[f.k] || 0)));
  if (lvl !== 'mun') {
    const scale = scaleFor(m, units.map(u => rate(u, f.k)).filter(v => v !== null));
    const visible = new Set(filtered.map(u => u.id));
    const byId = new Map(units.map(u => [u.id, u]));
    for (const [id, layer] of areaByUnit) {
      const u = byId.get(id);
      const r = u ? rate(u, f.k) : null;
      const shown = u && visible.has(id);
      layer.setStyle({fillColor: view === 'choro' && shown ? scale.fill(r) : NO_DATA, fillOpacity: shown ? (view === 'choro' ? .72 : .25) : .08});
      layer.unbindTooltip();
      if (u) layer.bindTooltip(`${esc(u.name)}<br>${esc(m.name)}: ${countText(u, m)}<br>${rateText(u, f.k)} ${esc(baseLabel(m))}`, {sticky: true});
      const el = layer.getElement && layer.getElement();
      if (el && u) el.setAttribute('aria-label', `${u.name}; ${m.name}: ${countText(u, m)}; ${rateText(u, f.k)}; abrir`);
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
    if (view === 'choro') {
      const [start, end, help] = rateLegend(m, scale, lvl === 'br' ? 'as UFs' : 'as cidades do estado');
      setLegend(m, `${m.name}: percentual ${baseLabel(m)}`, start, end, help + ' Áreas apagadas ficaram fora dos filtros. Clique em uma área para abrir.');
    } else {
      setLegend(m, `${m.name}: contagem por ${lvl === 'br' ? 'UF' : 'município'}`, '0', fmt(maxCount), `Círculos no centro de cada área; maiores representam mais registros. Referência máxima fixa: ${fmt(maxCount)}. Clique para abrir.`);
    }
    window.ATLAS_QA.drawn = {areas: areaByUnit.size, markers: markers.getLayers().length};
    return;
  }
  if (view === 'zones') return drawZones(f, m);
  const mapped = filtered.filter(plotted);
  if (view === 'heat' && mapped.length) {
    const points = mapped.filter(p => p[f.k] > 0).map(p => [p.lat, p.lon, p[f.k] / maxCount]);
    if (points.length) heat = L.heatLayer(points, {radius: 23, blur: 18, maxZoom: 12, max: 1, minOpacity: .12, gradient: {.15: PALETTE[0], .35: PALETTE[1], .55: PALETTE[2], .75: PALETTE[3], 1: PALETTE[4]}}).addTo(map);
  }
  const marginScale = m.kind === 'margin' ? scaleFor(m, mapped.map(p => rate(p, f.k)).filter(v => v !== null)) : null;
  for (const p of mapped) {
    const r = rate(p, f.k);
    const t = view === 'rate' ? (r ?? 0) / 100 : p[f.k] / maxCount;
    const zero = p[f.k] === 0 && !marginScale;
    const marker = L.circleMarker([p.lat, p.lon], {
      radius: view === 'heat' ? 4.8 : view === 'rate' ? 8 : 3 + 20 * Math.sqrt(p[f.k] / maxCount),
      weight: 1, color: view === 'heat' ? '#17334d' : '#16394b',
      fillColor: zero ? '#68768a' : marginScale ? marginScale.fill(r) : view === 'heat' ? '#f5f9ff' : color(t), fillOpacity: zero ? 0 : view === 'heat' ? .65 : .82,
    });
    marker.bindTooltip(`${esc(p.name)}<br>${esc(m.name)}: ${countText(p, m)} (${rateText(p, f.k)} ${esc(baseLabel(m))})`, {direction: 'top'});
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
  if (marginScale) {
    const [start, end, help] = rateLegend(m, marginScale, 'os locais exibidos');
    setLegend(m, `${m.name}: percentual ${baseLabel(m)}`, start, end, help);
  } else {
    setLegend(m, `${m.name}: ${view === 'heat' ? 'intensidade visual relativa dos pontos' : view === 'rate' ? 'percentual ' + baseLabel(m) : 'contagem por local'}`,
      view === 'heat' ? 'Menor intensidade' : view === 'rate' ? '0%' : '0',
      view === 'heat' ? 'Maior intensidade' : view === 'rate' ? '100%' : fmt(maxCount),
      view === 'heat'
        ? 'Calor relativo: manchas podem se sobrepor. Pontos brancos são locais consultáveis; círculos vazados indicam zero. Valores zero não geram calor. Escala por indicador; não comparar cores entre indicadores.'
        : view === 'rate' ? 'Círculos de tamanho fixo; cor em escala de 0 a 100%. Consulte a taxa exata no ponto.'
          : `Círculos maiores representam mais registros. Referência máxima fixa do município: ${fmt(maxCount)} por local; filtros não alteram essa referência.`);
  }
  window.ATLAS_QA.drawn = {areas: 0, markers: markers.getLayers().length, heat: heat ? heat._latlngs.length : 0};
}

function ensureZoneGeometry() {
  if (zoneGeometry) return zoneGeometry;
  const feature = GEO_UF && GEO_UF.features.find(x => x.properties.tse === state.mun);
  const sites = placeRows.filter(plotted);
  if (!feature || !sites.length) {
    zoneGeometry = {cells: [], boundaries: [], sites: []};
    return zoneGeometry;
  }
  zoneGeometry = {...ZoneGeometry.build(sites.map(p => [p.lon, p.lat]), feature.geometry.coordinates, sites.map(p => p.zone)), sites};
  return zoneGeometry;
}

function drawZones(f, m) {
  const g = ensureZoneGeometry();
  const kept = new Set(filtered.map(p => p.idx));
  const byZone = new Map();
  for (const p of filtered) {
    let a = byZone.get(p.zone);
    if (!a) {
      a = {kind: 'zone', zone: p.zone, name: `Zona ${p.zone}`, sections: 0, places: 0, sectionIds: []};
      for (const k of SUM_KEYS) a[k] = 0;
      byZone.set(p.zone, a);
    }
    a.sections += p.sections;
    a.places += 1;
    a.sectionIds.push(...p.sectionIds);
    for (const k of SUM_KEYS) a[k] += p[k];
  }
  for (const z of byZone.values()) withPrevious(z);
  zoneRowsDrawn = new Map([...byZone.values()].map(z => [rowKey(z), z]));
  const scale = scaleFor(m, [...byZone.values()].map(z => rate(z, f.k)).filter(v => v !== null), true);
  let drawn = 0;
  g.cells.forEach((cell, i) => {
    if (!cell) return;
    const site = g.sites[i];
    const z = kept.has(site.idx) ? byZone.get(site.zone) : null;
    const fill = z ? scale.fill(rate(z, f.k)) : NO_DATA;
    const layer = L.polygon(cell, {weight: .6, color: fill, fillColor: fill, fillOpacity: z ? .68 : .15, opacity: z ? .68 : .15});
    const note = z && PAST_KINDS.includes(m.kind) && z.previousNote ? `<br>${esc(z.previousNote)}` : '';
    layer.bindTooltip(z ? `Zona ${z.zone} (área aproximada)<br>${esc(m.name)}: ${countText(z, m)}<br>${rateText(z, f.k)} ${esc(baseLabel(m))}${note}` : `Zona ${site.zone}: fora dos filtros`, {sticky: true});
    if (z) layer.on('click', () => selectRow(z, false));
    layer.addTo(zoneLayers);
    drawn++;
  });
  if (g.boundaries.length) L.polyline(g.boundaries, {color: '#0b1423', weight: 1.8, opacity: .9, interactive: false}).addTo(zoneLayers);
  for (const z of byZone.values()) {
    const pts = g.sites.filter(p => p.zone === z.zone && kept.has(p.idx));
    if (!pts.length) continue;
    const center = [pts.reduce((a, p) => a + p.lat, 0) / pts.length, pts.reduce((a, p) => a + p.lon, 0) / pts.length];
    L.marker(center, {icon: L.divIcon({className: 'zone-label', html: String(z.zone), iconSize: null}), interactive: false, keyboard: false}).addTo(zoneLayers);
  }
  for (const p of filtered.filter(plotted)) {
    L.circleMarker([p.lat, p.lon], {radius: 2, weight: .6, color: '#0b1423', opacity: .7, fillColor: '#f5f9ff', fillOpacity: .7})
      .bindTooltip(`${esc(p.name)}<br>Zona ${p.zone}<br>${esc(m.name)}: ${countText(p, m)} (${rateText(p, f.k)})`, {direction: 'top'})
      .on('click', () => selectRow(p, false)).addTo(markers);
  }
  const [start, end, help] = rateLegend(m, scale, 'as zonas');
  const missing = g.cells.length ? '' : ' Este município não tem malha ou locais com coordenada; as áreas não puderam ser desenhadas.';
  setLegend(m, `${m.name}: percentual ${baseLabel(m)} por zona`, start, end, `${help} Áreas aproximadas: cada local de votação recebe a região mais próxima dele, recortada pelo limite do município. O TSE não publica contornos de zona. Locais sem coordenada entram no total da zona, mas não geram área.${missing}`);
  window.ATLAS_QA.drawn = {areas: drawn, zones: byZone.size, boundaries: g.boundaries.length, markers: markers.getLayers().length, heat: 0};
}

function listColumns(lvl, f) {
  const o = state.office;
  const blocs = hasBlocs(o) ? [[o + '.left', 'Esquerda'], [o + '.pl', 'PL']] : [];
  const kind = metric(f.k).kind;
  const before = kind === 'change' ? [[o + '.up22', `UP ${prevYear()}`]] : kind === 'past' ? [[o + '.chg', `Variação desde ${prevYear()}`]] : [];
  const tail = [['aptos', 'Aptos'], ['comp', 'Comparec.'], ['abst', 'Abstenções'], [o + '.blank', 'Brancos'], [o + '.null', 'Nulos'], [o + '.valid', 'Válidos'], [upKey(), 'UP'], ...before, ...blocs];
  if (lvl === 'mun' && f.isZone) return {head: ['Zona', 'Locais', 'BUs'], tail};
  if (lvl === 'mun') return {head: ['Local de votação', 'Zona / local / seção', 'Bairro cadastral', 'BUs'], tail: [...tail, ['status', 'No mapa']]};
  return {head: [lvl === 'br' ? 'UF' : 'Município', lvl === 'br' ? 'Municípios' : 'Locais', 'BUs'], tail};
}

function rowKey(r) {
  if (r.kind === 'zone') return `z${r.zone}`;
  if (level() !== 'mun') return r.id;
  return r.kind === 'section' ? `s${r.zone}-${r.section}` : `p${r.idx}`;
}

function renderList(f, m) {
  const lvl = level(), cols = listColumns(lvl, f);
  const pages = Math.max(1, Math.ceil(rowData.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const slice = rowData.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  $('places-head').innerHTML = `<tr>${cols.head.map(h => `<th>${h}</th>`).join('')}<th>${esc(m.short)}</th><th>% ${esc(baseLabel(m))}</th>${cols.tail.map(([, h]) => `<th>${h}</th>`).join('')}</tr>`;
  const width = cols.head.length + 2 + cols.tail.length;
  const statusText = s => s === 1 ? 'sim' : s === 3 ? 'sim (conferido na UF)' : s === 2 ? 'fora do município' : 'sem coordenada';
  $('places-body').innerHTML = slice.map(r => {
    const key = esc(rowKey(r));
    const lead = r.kind === 'zone'
      ? `<td><button class="row-button" data-row="${key}">Zona ${r.zone}</button></td><td>${fmt(r.places)}</td><td>${fmt(r.sections)}</td>`
      : lvl === 'mun'
      ? `<td><button class="row-button" data-row="${key}">${esc(r.name)}${r.kind === 'section' ? ' (seção ' + r.section + ')' : ''}</button></td><td>${r.zone} / ${r.local}${r.kind === 'section' ? ' / ' + r.section : ''}</td><td>${esc(r.neighborhood)}</td><td>${fmt(r.sections)}</td>`
      : `<td><button class="row-button" data-row="${key}">${esc(r.name)}</button></td><td>${fmt(lvl === 'br' ? r.munis : r.places)}</td><td>${fmt(r.sections)}</td>`;
    const rest = cols.tail.map(([k]) => k === 'status' ? `<td>${statusText(r.status)}</td>` : k.endsWith('.chg') ? `<td>${rateText(r, k)}</td>` : `<td>${fmt(r[k])}</td>`).join('');
    return `<tr>${lead}<td>${countText(r, m)}</td><td>${rateText(r, f.k)}</td>${rest}</tr>`;
  }).join('') || `<tr><td colspan="${width}" class="empty">Nenhum registro corresponde aos filtros. Use "Limpar filtros".</td></tr>`;
  const word = lvl === 'br' ? 'UFs' : lvl === 'uf' ? 'municípios' : f.isZone ? 'zonas' : f.isSection ? 'seções' : 'locais';
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
  writeHash();
  if (r.kind === 'zone') {
    const pts = placeRows.filter(p => p.zone === r.zone && plotted(p)).map(p => [p.lat, p.lon]);
    if (pan && pts.length) map.fitBounds(L.latLngBounds(pts), {padding: [30, 30], maxZoom: 15});
    return;
  }
  if (pan && plotted(r)) {
    const m = metric();
    map.setView([r.lat, r.lon], Math.max(map.getZoom(), 15));
    L.popup().setLatLng([r.lat, r.lon]).setContent(`<strong>${esc(r.name)}</strong><br>${esc(m.name)}: <b>${countText(r, m)}</b><br>${rateText(r, m.key)} ${esc(baseLabel(m))}`).openOn(map);
  }
}

function renderDetail() {
  const lvl = level(), m = metric();
  const tiles = metricList().filter(x => x.kind !== 'occ' && (KEYS.includes(x.key) || ['abst', 'comp', 'aptos'].includes(x.key)));
  const numbers = obj => `<div class="detail-numbers">${tiles.filter(x => !PAST_KINDS.includes(x.kind) || (obj[x.key] !== null && obj[x.key] !== undefined)).map(x => `<div>${esc(x.short)}<strong>${countText(obj, x)}</strong>${x.key === 'aptos' && lvl === 'mun' && obj !== territory ? '' : rateText(obj, x.key) + ' ' + esc(baseLabel(x))}</div>`).join('')}</div>`;
  if (lvl !== 'mun' || !state.selected) {
    const hint = lvl === 'mun' ? 'Clique em um ponto ou no nome do local na tabela para abrir a ficha.' : `Clique em ${lvl === 'br' ? 'um estado' : 'um município'} no mapa ou na tabela para abrir o recorte.`;
    $('detail').innerHTML = `<div class="over">Recorte atual</div><h3 style="margin-top:15px">${esc(territoryName())}</h3><p class="small">${hint}</p>${numbers(territory)}<div class="note small">${lvl === 'mun' ? 'O ponto é uma localização administrativa. Abstenção é a contagem de ausências vinculadas às seções daquele local, não a localização das pessoas ausentes.' : 'As áreas são malhas do IBGE. A cor compara taxas entre unidades do mesmo nível, não densidade de eleitores.'}</div>`;
    return;
  }
  const r = rowData.find(x => rowKey(x) === state.selected) || filtered.find(x => rowKey(x) === state.selected) || zoneRowsDrawn.get(state.selected);
  if (!r) {
    state.selected = null;
    map.closePopup();
    return renderDetail();
  }
  if (r.kind === 'zone') {
    $('detail').innerHTML = `<div class="over">Zona eleitoral</div><h3 style="margin-top:13px">Zona ${r.zone}</h3><p class="small">${fmt(r.places)} locais e ${fmt(r.sections)} BUs incluídos (respeita os filtros).</p><div class="status">${countText(r, m)} ${esc(m.short.toLowerCase())}: ${rateText(r, m.key)} ${esc(baseLabel(m))}</div>${numbers(r)}<p class="small">A área da zona no modo "Zonas" é aproximada: o TSE não publica contornos de zona.</p>`;
    return;
  }
  const ids = new Set(r.sectionIds);
  const secs = sectionRows.filter(s => s.place === r.idx && ids.has(s.section)).sort((a, b) => a.section - b.section);
  const coord = r.lat !== null && r.lon !== null
    ? `<a href="https://www.google.com/maps/search/?api=1&query=${r.lat}%2C${r.lon}" target="_blank" rel="noopener">Ver esta coordenada no Google Maps</a><p class="small" style="margin-top:10px">Coordenada do cadastro TSE: ${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}${r.status === 2 ? ' (fora do município na malha IBGE; não desenhada no mapa)' : ''}.</p>`
    : '<p class="small">Sem coordenada no cadastro TSE; o local não aparece no mapa, mas está na lista e nos totais.</p>';
  $('detail').innerHTML = `<div class="over">Zona ${r.zone} - local ${r.local}${r.kind === 'section' ? ' - seção ' + r.section : ''}</div><h3 style="margin-top:13px">${esc(r.name)}</h3><p class="small">${esc(r.address)}<br>${esc(r.neighborhood)} - ${esc(MUN.name)}/${esc(state.uf)}</p><div class="status">${countText(r, m)} ${esc(m.short.toLowerCase())}: ${rateText(r, m.key)} ${esc(baseLabel(m))}</div>${numbers(r)}<p class="small">${r.sections} BUs incluídos nesta ficha (respeita os filtros).</p>${coord}<details><summary>Boletins por seção (${secs.length})</summary><div class="table-box"><table><caption>${esc(m.name)} por seção primária</caption><thead><tr><th>Seção</th><th>Contagem</th><th>Taxa</th></tr></thead><tbody>${secs.map(s => `<tr><td>${s.section}</td><td>${countText(s, m)}</td><td>${rateText(s, m.key)}</td></tr>`).join('')}</tbody></table></div><p class="small">Seções secundárias, quando existentes, estão incluídas no BU primário; não há desagregação artificial.</p></details>`;
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
        const a = {label: key, places: 0, sections: 0, occupied: 0};
        for (const c of SUM_KEYS) a[c] = 0;
        g.set(key, a);
      }
      const a = g.get(key);
      a.places++;
      a.sections += p.sections;
      for (const c of SUM_KEYS) a[c] += p[c];
    }
    if (m.kind === 'cand') {
      for (const s of sectionRows) if (s[k] > 0) g.get(field === 'zone' ? s.zone : places[s.place][field]).occupied++;
    }
    return [...g.values()];
  };
  const occ = m.kind === 'cand';
  const code = state.office, year = prevYear();
  const prevCells = x => `<td>${fmt(x[code + '.up22'])}<br><small>${pct(rate(x, code + '.up22'))}</small></td><td>${x[code + '.chg'] === null ? `<small>${esc(x.previousNote || 'sem comparação')}</small>` : rateText(x, code + '.chg')}</td>`;
  const prevHead = `<th>UP ${year}</th><th>Variação desde ${year}</th>`;
  const cells = x => `<td>${fmt(x.aptos)}</td><td>${fmt(x.comp)}</td><td>${fmt(x.abst)}<br><small>${pct(rate(x, 'abst'))}</small></td><td>${countText(x, m)}<br><small>${rateText(x, k)}</small></td>${occ ? `<td>${fmt(x.occupied)}<br><small>${pct(x.sections ? 100 * x.occupied / x.sections : null)}</small></td>` : ''}<td>${fmt(x[up])}<br><small>${pct(rate(x, up))}</small></td><td>${fmt(x[state.office + '.blank'])}</td><td>${fmt(x[state.office + '.null'])}</td>`;
  const head = `<th>Aptos</th><th>Comparec.</th><th>Abstenções</th><th>${esc(m.short)}</th>${occ ? '<th>Seções com voto</th>' : ''}<th>UP</th><th>Brancos</th><th>Nulos</th>`;
  const zones = group('zone').sort((a, b) => a.label - b.label).map(z => {
    const values = MUN.previous.zones[z.label];
    MUN.previous.cols.forEach((c, i) => { z[c] = values ? values[i] : null; });
    z.previousNote = values ? '' : `zona sem correspondência em ${year}`;
    return deriveChange(z, state.uf);
  });
  const hoods = group('neighborhood').sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  $('territory-tables').innerHTML = `<div class="grid-two"><article class="panel"><h3>Zona não é região urbana</h3><p class="small">Zonas são unidades eleitorais e o TSE não publica seus contornos. A visualização "Zonas" do mapa divide o município pela proximidade dos locais de votação: os limites são aproximados.</p></article><article class="panel"><h3>Bairro da urna, não do eleitor</h3><p class="small">A comparação por bairro agrupa os locais pelo rótulo cadastral do TSE. Ela descreve onde os votos foram registrados, não o voto dos moradores de cada bairro.</p></article></div>
<h3 style="margin-top:22px">${zones.length} zonas: totais e participação</h3><div class="table-box"><table><caption>${esc(MUN.name)} completo. Candidaturas: percentual dos válidos. Seções com voto: BUs com ao menos 1 voto no indicador. Abstenção: percentual dos aptos.</caption><thead><tr><th>Zona</th>${head}${prevHead}</tr></thead><tbody id="zones-body">${zones.map(x => `<tr><td>${x.label}<br><small>${x.sections} BUs</small></td>${cells(x)}${prevCells(x)}</tr>`).join('')}</tbody></table></div>
${zoneMatrix(zones)}
<details><summary>Comparação pelos ${hoods.length} rótulos de bairro dos locais</summary><p class="small">Grafia mantida conforme o cadastro. Rótulos não foram fundidos por semelhança de nome. Não é um mapa de limites de bairros.</p><div class="table-box"><table><caption>Município completo, bairros em ordem alfabética</caption><thead><tr><th>Bairro do local</th><th>Locais</th>${head}</tr></thead><tbody id="neighborhoods-body">${hoods.map(x => `<tr><td>${esc(x.label)}</td><td>${x.places}</td>${cells(x)}</tr>`).join('')}</tbody></table></div></details>`;
}

function zoneMatrix(zones) {
  const series = metricList().filter(x => (x.kind === 'cand' || x.kind === 'margin') && KEYS.includes(x.key));
  if (!series.length) return '';
  const cell = (x, z, max) => {
    const r = rate(z, x.key);
    const t = r === null || !(max > 0) ? 0 : Math.abs(r) / max;
    const tint = x.kind === 'margin' ? (r < 0 ? '47,111,224' : '224,69,58') : '113,230,255';
    return `<td style="background:rgba(${tint},${(.55 * t).toFixed(3)})" title="${esc(x.name)}, zona ${z.label}: ${esc(countText(z, x))}">${x.kind === 'margin' ? pp(r) : pct(r)}</td>`;
  };
  const rows = series.map(x => {
    const max = Math.max(0, ...zones.map(z => Math.abs(rate(z, x.key) ?? 0)));
    return `<tr><td>${esc(x.name)}${x.tip ? tip(leftTip()) : ''}</td>${zones.map(z => cell(x, z, max)).join('')}</tr>`;
  }).join('');
  return `<h3 style="margin-top:22px">Candidaturas por zona</h3><p class="small">Percentual dos votos válidos de ${esc(office().name)} em cada zona; a cor compara as zonas dentro de cada linha. Passe o mouse para ver a contagem.</p><div class="table-box"><table class="zone-matrix"><caption>${esc(MUN.name)} completo, sem os filtros do mapa</caption><thead><tr><th>Indicador</th>${zones.map(z => `<th>Zona ${z.label}</th>`).join('')}</tr></thead><tbody id="zone-matrix-body">${rows}</tbody></table></div>`;
}

function renderCandidates() {
  const lvl = level(), o = office(), code = state.office, valid = territory[code + '.valid'];
  const deputy = !hasBlocs(code);
  let rows;
  const blocRows = hasBlocs(code)
    ? [{name: 'Campo da esquerda', n: 'bloco', votes: territory[code + '.left'], tip: true, pinned: true}, ...(code === 1 ? [] : [{name: 'PL', n: '22', votes: territory[code + '.pl'], tip: true, pinned: true}])]
    : [];
  if (code === 1) {
    rows = META.president.map(c => ({name: `${c.name} (${c.party})`, n: c.n, votes: territory['1.' + c.n]}));
    $('candidates-intro').innerHTML = `Candidaturas acompanhadas pelo atlas: Lula, Flávio Bolsonaro e Samara (UP). O campo da esquerda soma também as candidaturas de PCB e PSTU ${tip(leftTip())}. As demais entram nos votos válidos, mas não são exibidas.`;
  } else if (lvl === 'br') {
    rows = units.filter(u => u[upKey()] !== null).map(u => ({name: `UP em ${u.name}`, n: '80', votes: u[upKey()], den: u[code + '.valid']}));
    $('candidates-intro').innerHTML = `Votos da UP para ${esc(o.name)} em cada UF${deputy ? ' (candidaturas + legenda)' : ''}. Escolha um estado para ver cada candidatura.${hasBlocs(code) ? ' ' + tip(leftTip()) : ''}`;
  } else {
    rows = votables(state.uf, code).map(v => ({name: v.kind === 'legenda' ? 'Legenda UP (80)' : `${v.name} (${v.party})`, n: v.n, votes: territory[code + '.' + v.n], up: v.group === 'up'}));
    $('candidates-intro').innerHTML = hasBlocs(code)
      ? `Candidaturas válidas da UP, dos partidos do campo da esquerda e do PL para ${esc(o.name)} em ${esc(ufName(state.uf))} ${tip(leftTip())}.`
      : `Candidaturas válidas da UP e voto de legenda para ${esc(o.name)} em ${esc(ufName(state.uf))}. A última coluna mostra o peso de cada uma nos votos da UP no cargo.`;
  }
  rows.sort((a, b) => (b.votes || 0) - (a.votes || 0) || a.name.localeCompare(b.name, 'pt-BR'));
  rows = [...blocRows, ...rows];
  const upTotal = territory[upKey()];
  const shareOfUp = deputy && code !== 1 && lvl !== 'br';
  $('candidates-head').innerHTML = `<tr><th>Candidatura</th><th>Número</th><th>Votos</th><th>% dos válidos</th>${shareOfUp ? '<th>% dos votos da UP no cargo</th>' : ''}</tr>`;
  $('candidates-summary').textContent = code === 1 ? 'Candidaturas presidenciais no recorte' : hasBlocs(code) ? `UP, campo da esquerda e PL: ${o.name}` : `Unidade Popular: ${o.name}`;
  $('candidates-caption').textContent = `${territoryName()} - ${rows.length} linhas`;
  $('candidates-body').innerHTML = rows.map(r => `<tr${r.pinned ? ' class="pinned"' : ''}><td>${esc(r.name)}${r.tip ? tip(leftTip()) : ''}</td><td>${esc(r.n)}</td><td>${fmt(r.votes)}</td><td>${pct((r.den ?? valid) > 0 && r.votes !== null && r.votes !== undefined ? 100 * r.votes / (r.den ?? valid) : null)}</td>${shareOfUp ? `<td>${pct(upTotal > 0 && r.votes !== undefined ? 100 * r.votes / upTotal : null)}</td>` : ''}</tr>`).join('') || `<tr><td colspan="${shareOfUp ? 5 : 4}" class="empty">A UP não teve candidatura válida para este cargo neste estado.</td></tr>`;
}

function corrSeries() {
  const list = [];
  const add = (key, label, code) => { if (KEYS.includes(key) && territory[key] !== null && territory[key] !== undefined) list.push({key, label: `${OFFICE_ABBR[code]} ${label}`, office: code}); };
  for (const c of META.president) add('1.' + c.n, `${c.name} (${c.party})`, 1);
  add('1.left', 'Campo da esquerda', 1);
  for (const code of [3, 5]) {
    add(code + '.up', 'UP', code);
    add(code + '.left', 'Campo da esquerda', code);
    add(code + '.pl', 'PL', code);
  }
  for (const code of [6, 7]) add(code + '.up', 'UP', code);
  if (state.office !== 1 && level() !== 'br') {
    votables(state.uf, state.office)
      .filter(v => KEYS.includes(state.office + '.' + v.n))
      .sort((a, b) => (territory[state.office + '.' + b.n] || 0) - (territory[state.office + '.' + a.n] || 0))
      .slice(0, MAX_CORR_CANDIDATES)
      .forEach(v => add(state.office + '.' + v.n, v.kind === 'legenda' ? 'Legenda UP' : `${v.name} (${v.party})`, state.office));
  }
  return list;
}

function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const result = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let t = i; t <= j; t++) result[order[t][1]] = avg;
    i = j + 1;
  }
  return result;
}

function spearman(xs, ys) {
  const rx = ranks(xs), ry = ranks(ys), n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

function corrUnits() { return level() === 'mun' ? placeRows : units; }

function shareOf(u, s) {
  const v = u[s.key], den = u[s.office + '.valid'];
  return v === null || v === undefined || !(den > 0) ? null : v / den;
}

function correlate(a, b) {
  const xs = [], ys = [], names = [];
  for (const u of corrUnits()) {
    const x = shareOf(u, a), y = shareOf(u, b);
    if (x === null || y === null) continue;
    xs.push(x);
    ys.push(y);
    names.push(u.name);
  }
  return {rho: xs.length >= MIN_CORR_UNITS ? spearman(xs, ys) : null, n: xs.length, xs, ys, names};
}

function renderCorrelation() {
  const lvl = level(), series = corrSeries();
  const unitWord = lvl === 'mun' ? 'locais de votação' : lvl === 'uf' ? 'municípios' : 'UFs';
  $('corr-intro').innerHTML = `Cada célula mede se duas candidaturas vão bem nos mesmos ${unitWord} de ${esc(territoryName())} (correlação de Spearman entre os percentuais dos válidos de cada cargo). Perto de 1: crescem juntas; perto de 0: sem relação; negativa: uma vai melhor onde a outra vai pior. Correlação alta não quer dizer que as mesmas pessoas votaram nas duas. ${lvl === 'br' ? 'No nível nacional são só 27 UFs: leia com cautela. ' : ''}Abaixo de ${MIN_CORR_UNITS} unidades com votos válidos a célula fica em branco. Clique em uma célula para ver a dispersão. ${tip(leftTip())}`;
  const matrix = series.map(a => series.map(b => a.key === b.key ? {rho: 1, n: null} : correlate(a, b)));
  corrState = {series, matrix};
  const cell = (c, i, j) => {
    if (i === j) return '<td class="corr-diag">1</td>';
    if (c.rho === null) return `<td class="corr-empty" title="${c.n} unidades">-</td>`;
    const tint = c.rho >= 0 ? '113,230,255' : '255,191,89';
    return `<td style="background:rgba(${tint},${(.6 * Math.abs(c.rho)).toFixed(3)})"><button type="button" class="corr-cell" data-i="${i}" data-j="${j}" aria-label="${esc(series[i].label)} x ${esc(series[j].label)}: ${c.rho.toFixed(2)}">${c.rho.toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</button></td>`;
  };
  $('corr-box').innerHTML = series.length < 2
    ? '<p class="small">Não há candidaturas suficientes neste recorte.</p>'
    : `<table class="corr"><caption>${esc(territoryName())}: ${series.length} indicadores, unidades = ${unitWord}</caption><thead><tr><th></th>${series.map(s => `<th>${esc(s.label)}</th>`).join('')}</tr></thead><tbody>${series.map((s, i) => `<tr><th scope="row">${esc(s.label)}</th>${matrix[i].map((c, j) => cell(c, i, j)).join('')}</tr>`).join('')}</tbody></table>`;
  $('corr-detail').innerHTML = '';
}

function renderScatter(i, j) {
  const a = corrState.series[i], b = corrState.series[j], c = corrState.matrix[i][j];
  corrState.open = [a.key, b.key];
  writeHash();
  const w = 640, h = 340, pad = 44;
  const maxX = Math.max(...c.xs, 1e-9), maxY = Math.max(...c.ys, 1e-9);
  const px = x => pad + (w - 2 * pad) * x / maxX, py = y => h - pad - (h - 2 * pad) * y / maxY;
  const dots = c.xs.map((x, k) => `<circle cx="${px(x).toFixed(1)}" cy="${py(c.ys[k]).toFixed(1)}" r="3"><title>${esc(c.names[k])}: ${pct(100 * x)} x ${pct(100 * c.ys[k])}</title></circle>`).join('');
  const axis = `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}"/><text x="${w / 2}" y="${h - 10}" text-anchor="middle">${esc(a.label)} (% dos válidos, até ${pct(100 * maxX)})</text><text x="14" y="${h / 2}" text-anchor="middle" transform="rotate(-90 14 ${h / 2})">${esc(b.label)} (até ${pct(100 * maxY)})</text>`;
  $('corr-detail').innerHTML = `<div class="panel corr-panel"><h3>${esc(a.label)} x ${esc(b.label)}</h3><p class="small">Correlação de Spearman ${c.rho.toLocaleString('pt-BR', {maximumFractionDigits: 2})} em ${fmt(c.n)} unidades. Cada ponto é uma unidade do recorte.</p><svg class="scatter" viewBox="0 0 ${w} ${h}" role="img" aria-label="Dispersão entre ${esc(a.label)} e ${esc(b.label)}">${axis}${dots}</svg><div class="buttons"><button type="button" data-show="${i}">Ver ${esc(a.label)} no mapa</button><button type="button" data-show="${j}">Ver ${esc(b.label)} no mapa</button></div></div>`;
}

function showSeries(s) {
  state.office = s.office;
  state.metric = s.key;
  refreshMetricOptions();
  syncTerritoryControls();
  renderAll();
  writeHash();
  $('atlas').scrollIntoView({behavior: reduceMotion() ? 'instant' : 'smooth'});
}

function renderStatic() {
  const c = META.coverage, checks = META.checks;
  const plottedCount = (c.places_status_1 || 0) + (c.places_status_3 || 0), outside = c.places_status_2 || 0, missing = c.places_status_0 || 0;
  $('method-data').innerHTML = [
    `${fmt(c.sections)} boletins primários (seções com resultado) agrupados em ${fmt(c.places)} locais de votação.`,
    `${fmt(c.secondary)} seções secundárias agregadas a primárias no cadastro, sem inventar resultados separados.`,
    `${fmt(plottedCount)} locais com coordenada conferida contra a malha municipal; ${fmt(outside)} com coordenada fora do município e ${fmt(missing)} sem coordenada, mantidos na lista e nos totais.`,
    'Malhas do IBGE: UFs e municípios. Zonas eleitorais: áreas aproximadas pela proximidade dos locais de votação (Voronoi recortado pelo município), porque o TSE não publica contornos de zona. Sem polígonos de bairro.',
    ...META.missing_mesh.map(m => `Sem malha municipal: ${m}. Os locais desse município foram conferidos só contra a malha da UF.`),
    'Presidente: Lula, Flávio Bolsonaro e Samara (UP), mais o campo da esquerda. Governador e Senador: UP, candidaturas dos partidos do campo da esquerda e do PL. Deputados: somente a Unidade Popular. Válidos, brancos e nulos são os denominadores.',
    leftTip(),
  ].map(t => `<li>${esc(t)}</li>`).join('');
  $('method-checks').innerHTML = [
    `${fmt(checks.comparisons)} comparações com as totalizações oficiais do TSE (nacional, cada UF e cada cargo); ${fmt(checks.failed)} divergências.`,
    `Invariantes por seção (comparecimento + abstenções = aptos; válidos + brancos + nulos = comparecimento x votos por eleitor): ${Object.keys(checks.invariant_violations).length ? 'ver relatório' : 'nenhuma violação'}.`,
    'Candidaturas e blocos: votos / válidos do cargo. Esquerda x PL: diferença dos dois percentuais, em pontos percentuais. Brancos, nulos e válidos: contagem / votos do cargo (igual ao comparecimento quando há um voto por eleitor).',
    'Ocupação de urnas: seções (BUs) com ao menos um voto no indicador / seções do recorte.',
    `Comparação com ${META.previous.year}: em cada zona e cargo, a soma dos votos de todos os partidos fecha com os válidos do detalhe da apuração; a UP para Presidente soma ${fmt(BR.rows.reduce((a, r) => a + (r[5 + BR.cols.indexOf('1.up22')] || 0), 0))} votos no Brasil, igual ao resultado oficial. Variação = diferença dos percentuais dos válidos, em pontos percentuais.`,
    'Abstenções e comparecimento: contagem / aptos. Taxas agregadas são razões entre somas, nunca médias de percentuais.',
    'Não foi realizada validação criptográfica das assinaturas dos boletins ou dos arquivos JWS.',
  ].map(t => `<li>${esc(t)}</li>`).join('');
  const sources = META.sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.description)}</a>: ${s.last_modified ? 'publicado em ' + esc(s.last_modified) + '; ' : ''}baixado em ${esc(s.fetched_at)}; SHA-256 <code>${esc(s.sha256.slice(0, 16))}...</code></li>`);
  sources.push(`<li>Mais ${fmt(META.source_counts.feeds - 1)} totalizações do TSE por UF e cargo (resultados.tse.jus.br) e ${fmt(META.source_counts.meshes - 1)} malhas municipais do IBGE (servicodados.ibge.gov.br), com hash no manifesto do pipeline.</li>`);
  $('sources').innerHTML = sources.join('');
  $('footer').textContent = `Dados gerados em ${new Date(META.generated_at).toLocaleString('pt-BR')}. Visualização informativa com dados agregados, sem recomendações de abordagem eleitoral.`;
}

const FILTER_PARAMS = [
  ['zona', 'zone'], ['bairro', 'neighborhood'], ['busca', 'query'], ['unidade', 'unit'], ['secao', 'section-filter'],
  ['faixa', 'range-kind'], ['min', 'min-value'], ['max', 'max-value'], ['ordem', 'sort'],
];
let pendingParams = null;

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const officeCode = Number(p.get('cargo'));
  if (META.offices.some(o => o.code === officeCode)) state.office = officeCode;
  state.metric = p.get('indicador') || '';
  state.view = p.get('vis') || '';
  pendingParams = p;
  return {uf: META.ufs.some(u => u.uf === p.get('uf')) ? p.get('uf') : '', mun: p.get('mun') || ''};
}

function applyPendingParams() {
  const p = pendingParams;
  pendingParams = null;
  if (!p) return;
  for (const [param, id] of FILTER_PARAMS) {
    const value = p.get(param);
    if (value === null || $(id).disabled) continue;
    const el = $(id);
    if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === value)) continue;
    el.value = value;
  }
  state.page = Math.max(0, Number(p.get('pagina') || 1) - 1);
  render();
  const selected = p.get('sel');
  if (selected) {
    const row = rowData.find(r => String(rowKey(r)) === selected) || filtered.find(r => String(rowKey(r)) === selected) || zoneRowsDrawn.get(selected);
    if (row) selectRow(row, false);
  }
  const pair = (p.get('corr') || '').split('|');
  if (pair.length === 2 && corrState) {
    const i = corrState.series.findIndex(x => x.key === pair[0]), j = corrState.series.findIndex(x => x.key === pair[1]);
    if (i >= 0 && j >= 0 && i !== j && corrState.matrix[i][j].rho !== null) renderScatter(i, j);
  }
}

function writeHash() {
  if (pendingParams) return;
  const p = new URLSearchParams();
  p.set('cargo', state.office);
  if (state.uf) p.set('uf', state.uf);
  if (state.mun) p.set('mun', state.mun);
  p.set('indicador', state.metric);
  p.set('vis', state.view);
  const defaults = {unit: 'place', 'range-kind': 'count', sort: level() === 'mun' ? 'name' : 'count-desc'};
  for (const [param, id] of FILTER_PARAMS) {
    const value = $(id).value;
    if (value !== '' && value !== defaults[id] && !$(id).disabled) p.set(param, value);
  }
  if (state.page) p.set('pagina', state.page + 1);
  if (state.selected) p.set('sel', state.selected);
  if (corrState && corrState.open) p.set('corr', corrState.open.join('|'));
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

function bindTips() {
  const pop = document.createElement('div');
  pop.id = 'tip-pop';
  pop.hidden = true;
  pop.setAttribute('aria-hidden', 'true');
  document.body.appendChild(pop);
  let active = null;
  const show = el => {
    active = el;
    pop.textContent = el.dataset.tip;
    pop.hidden = false;
    const r = el.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
    const below = r.bottom + 6;
    pop.style.top = (below + pop.offsetHeight > innerHeight ? Math.max(8, r.top - pop.offsetHeight - 6) : below) + 'px';
  };
  const hide = () => { active = null; pop.hidden = true; };
  document.addEventListener('mouseover', e => { const t = e.target.closest('.tip'); if (t) show(t); });
  document.addEventListener('mouseout', e => { if (e.target.closest('.tip')) hide(); });
  document.addEventListener('focusin', e => { if (e.target.classList.contains('tip')) show(e.target); });
  document.addEventListener('focusout', hide);
  document.addEventListener('click', e => { const t = e.target.closest('.tip'); if (t) { e.preventDefault(); show(t); } });
  addEventListener('scroll', () => { if (active) show(active); }, {passive: true});
  window.ATLAS_QA.tip = () => pop.hidden ? null : pop.textContent;
}

function bind() {
  bindTips();
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
      if (id === 'metric') {
        state.metric = $('metric').value;
        refreshViewOptions();
      }
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
  $('corr-box').addEventListener('click', e => {
    const b = e.target.closest('[data-i]');
    if (b) renderScatter(Number(b.dataset.i), Number(b.dataset.j));
  });
  $('corr-detail').addEventListener('click', e => {
    const b = e.target.closest('[data-show]');
    if (b) showSeries(corrState.series[Number(b.dataset.show)]);
  });
  $('reset').addEventListener('click', () => { clearFilters(); render(); frameTerritory(); });
  $('expand').addEventListener('click', () => expand());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') expand(false); });
  window.addEventListener('hashchange', async () => {
    const target = readHash();
    if (target.uf !== state.uf || target.mun !== state.mun) {
      await setTerritory(target.uf, target.mun);
    } else {
      refreshMetricOptions();
      syncTerritoryControls();
      clearFilters();
      renderAll();
    }
    applyPendingParams();
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
  corr: (a, b) => {
    const series = corrSeries();
    const sa = series.find(x => x.key === a), sb = series.find(x => x.key === b);
    return sa && sb ? correlate(sa, sb) : null;
  },
  corrSize: () => corrState ? corrState.series.length : 0,
  rows: () => rowData.map(r => ({zone: r.zone, name: r.name, kind: r.kind, values: Object.fromEntries(KEYS.map(k => [k, r[k]]))})),
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
    applyPendingParams();
    writeHash();
    window.ATLAS_QA.ready = true;
  } catch (error) {
    $('filter-stats').textContent = 'Não foi possível carregar os dados do atlas: ' + error.message;
    window.ATLAS_QA.errors.push(String(error));
  } finally {
    setLoading(false);
  }
})();
