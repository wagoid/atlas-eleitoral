import {spawn} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const root = dirname(fileURLToPath(import.meta.url));
const site = join(root, '..', 'site');
const out = join(root, 'out');
const port = Number(process.env.QA_PORT || 8765);
const base = `http://127.0.0.1:${port}/`;
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';
mkdirSync(out, {recursive: true});

const results = [];
function check(name, ok, detail = '') {
  results.push({name, ok: Boolean(ok), detail});
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
}

const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', site], {stdio: 'ignore'});
await new Promise(r => setTimeout(r, 800));
const browser = await chromium.launch({executablePath: chrome, headless: true});

try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(String(e)));
  const qa = fn => page.evaluate(fn);
  const settle = async () => {
    await page.waitForFunction(() => window.ATLAS_QA && window.ATLAS_QA.ready && document.getElementById('loading').hidden, null, {timeout: 60000});
    await page.waitForTimeout(150);
  };
  const choose = async (id, value) => { await page.selectOption('#' + id, value); await settle(); };
  const fill = async (id, value) => { await page.fill('#' + id, value); await page.waitForTimeout(100); };

  let t0 = Date.now();
  await page.goto(base);
  await settle();
  check('carrega nível nacional', (await qa(() => window.ATLAS_QA.state().level)) === 'br', `${Date.now() - t0} ms`);
  const meta = await page.evaluate(() => fetch('data/meta.json').then(r => r.json()));
  check('reconciliação do build sem divergências', meta.checks.failed === 0 && Object.keys(meta.checks.invariant_violations).length === 0, JSON.stringify(meta.checks.info));
  let terr = await qa(() => window.ATLAS_QA.territory());
  check('Brasil: comparecimento = feed TSE', terr.comp === 125275835, String(terr.comp));
  check('Brasil: Samara (80) = feed TSE', terr['1.80'] === 122911, String(terr['1.80']));
  check('Brasil: 28 UFs (com exterior) na lista', (await qa(() => window.ATLAS_QA.list())) === 28);
  check('Brasil: 27 áreas de UF no mapa', (await qa(() => window.ATLAS_QA.drawn.areas)) === 27);
  check('indicador padrão é a UP', (await page.inputValue('#metric')) === '1.80');
  const presidentMetrics = await qa(() => window.ATLAS_QA.metrics());
  check('Presidente: só Lula, Flávio e Samara', JSON.stringify(meta.president.map(c => c.n).sort()) === '["13","22","80"]' && presidentMetrics.filter(k => /^1\.\d+$/.test(k)).length === 3, presidentMetrics.join(','));
  check('ordem: Samara, Lula, Flávio, válidos, brancos e nulos, brancos, nulos', presidentMetrics.slice(0, 7).join() === '1.80,1.13,1.22,1.valid,1.bn,1.blank,1.null', presidentMetrics.join());
  await page.screenshot({path: join(out, 'brasil-desktop.png'), fullPage: false});
  await page.locator('.map-grid').screenshot({path: join(out, 'brasil-mapa.png')});

  await choose('office', '5');
  check('Senador nacional: indicador UP no cargo', (await page.inputValue('#metric')) === '5.up');
  terr = await qa(() => window.ATLAS_QA.territory());
  check('Senador nacional: votos UP > 0', terr['5.up'] > 0, String(terr['5.up']));
  await choose('office', '1');

  t0 = Date.now();
  await choose('uf', 'MG');
  check('MG: nível estadual', (await qa(() => window.ATLAS_QA.state().level)) === 'uf', `${Date.now() - t0} ms`);
  check('MG: 853 municípios na lista', (await qa(() => window.ATLAS_QA.list())) === 853);
  check('MG: 853 áreas municipais', (await qa(() => window.ATLAS_QA.drawn.areas)) === 853);
  await page.screenshot({path: join(out, 'mg-desktop.png')});
  await page.locator('.map-grid').screenshot({path: join(out, 'mg-mapa.png')});
  await choose('view', 'count');
  check('MG: círculos de contagem desenhados', (await qa(() => window.ATLAS_QA.drawn.markers)) > 0);
  await choose('view', 'choro');

  await choose('mun', '54038');
  terr = await qa(() => window.ATLAS_QA.territory());
  const ref = {aptos: 540033, comp: 429516, abst: 110517, '1.valid': 409921, '1.blank': 7763, '1.null': 11832, '1.13': 163879, '1.22': 206793, '1.80': 399};
  check('Uberlândia: totais iguais ao atlas de referência', Object.entries(ref).every(([k, v]) => terr[k] === v), JSON.stringify(Object.fromEntries(Object.keys(ref).map(k => [k, terr[k]]))));
  check('Uberlândia: brancos e nulos = 19.595', terr['1.bn'] === 19595, String(terr['1.bn']));
  check('Uberlândia: 137 locais', (await qa(() => window.ATLAS_QA.list())) === 137);
  check('Uberlândia: 137 marcadores no mapa', (await qa(() => window.ATLAS_QA.drawn.markers)) === 137);
  check('Uberlândia: calor sem pontos zerados', (await qa(() => window.ATLAS_QA.drawn.heat)) === 119, String(await qa(() => window.ATLAS_QA.drawn.heat)));

  await fill('min-value', '1');
  check('mínimo 1 por local: 119 locais com voto UP', (await qa(() => window.ATLAS_QA.list())) === 119);
  check('soma da seleção = 399', (await qa(() => window.ATLAS_QA.sum('1.80'))) === 399);
  await choose('unit', 'section');
  check('mínimo 1 por seção: 354 BUs', (await qa(() => window.ATLAS_QA.list())) === 354);
  check('modo seção: soma ainda 399', (await qa(() => window.ATLAS_QA.sum('1.80'))) === 399);
  await choose('sort', 'count-desc');
  check('ordenação não muda a soma', (await qa(() => window.ATLAS_QA.sum('1.80'))) === 399);
  await fill('min-value', '');
  await choose('zone', '278');
  await fill('section-filter', '7');
  check('zona 278 + seção 7: uma linha', (await qa(() => window.ATLAS_QA.list())) === 1);
  await page.click('#places-body .row-button');
  await page.waitForTimeout(200);
  const detail = await page.textContent('#detail');
  check('ficha da seção abre com o local', detail.includes('seção 7'), detail.slice(0, 80));
  await fill('min-value', '10');
  await fill('max-value', '2');
  check('faixa inválida: lista vazia e enquadrar desabilitado', (await qa(() => window.ATLAS_QA.list())) === 0 && await page.isDisabled('#fit'));
  await page.click('#reset');
  await page.waitForTimeout(200);
  check('limpar filtros volta a 137 locais', (await qa(() => window.ATLAS_QA.list())) === 137 && (await page.inputValue('#unit')) === 'place');
  await fill('query', 'jacy de assis');
  check('busca sem acento encontra o local', (await qa(() => window.ATLAS_QA.list())) >= 1);
  await page.click('#reset');
  await choose('view', 'rate');
  check('modo percentual sem camada de calor', (await qa(() => window.ATLAS_QA.drawn.heat)) === 0);
  await choose('view', 'heat');
  const headCells = await page.$$eval('#places-head th', ths => ths.length);
  const rowCells = await page.$$eval('#places-body tr:first-child td', tds => tds.length);
  check('cabeçalho e células da lista coincidem', headCells === rowCells, `${headCells}/${rowCells}`);
  await page.screenshot({path: join(out, 'uberlandia-desktop.png')});
  await page.locator('.map-grid').screenshot({path: join(out, 'uberlandia-mapa.png')});

  await choose('office', '5');
  terr = await qa(() => window.ATLAS_QA.territory());
  check('Uberlândia Senador: UP no cargo = 2196', terr['5.up'] === 2196, String(terr['5.up']));
  const senateMetrics = await qa(() => window.ATLAS_QA.metrics());
  check('Senador: candidaturas UP 800 e 808 disponíveis', senateMetrics.includes('5.800') && senateMetrics.includes('5.808'));
  const senateCards = await page.textContent('#city-cards');
  check('Senador: denominador de 2 votos por eleitor explicado', senateCards.includes('2 por eleitor'));
  await choose('office', '6');
  check('Deputado Federal: legenda e candidaturas UP', (await qa(() => window.ATLAS_QA.metrics())).includes('6.80'));
  await page.screenshot({path: join(out, 'uberlandia-depfed.png')});

  await page.click('#expand');
  await page.waitForTimeout(200);
  check('ampliar mapa', await page.$eval('#atlas', el => el.classList.contains('map-expanded')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape fecha a ampliação', !(await page.$eval('#atlas', el => el.classList.contains('map-expanded'))));

  const tiles = await qa(() => window.ATLAS_QA.tiles());
  check('mapa-base carregou tiles', tiles.loaded > 0, JSON.stringify(tiles));

  t0 = Date.now();
  await page.goto(base + '#cargo=1&uf=SP&mun=71072&indicador=1.80&vis=heat');
  await settle();
  const spLoad = Date.now() - t0;
  const spPlaces = await qa(() => window.ATLAS_QA.list());
  check('link direto para São Paulo/SP', (await qa(() => window.ATLAS_QA.state().mun)) === '71072', `${spPlaces} locais, ${spLoad} ms`);
  check('São Paulo: paginação ativa', (await page.textContent('#pager-top')).includes('Página 1 de'));
  t0 = Date.now();
  await choose('unit', 'section');
  check('São Paulo: modo seção (~26 mil BUs) responde', (await qa(() => window.ATLAS_QA.list())) > 20000, `${Date.now() - t0} ms`);
  await page.screenshot({path: join(out, 'sao-paulo-desktop.png')});

  await page.goto(base + '#cargo=5&uf=ZZ');
  await settle();
  const zz = await qa(() => window.ATLAS_QA.state());
  check('Exterior força Presidente', zz.uf === 'ZZ' && zz.office === 1);
  check('Exterior lista cidades', (await qa(() => window.ATLAS_QA.list())) > 50);

  await page.goto(base + '#cargo=3&uf=AC');
  await settle();
  check('UF sem candidatura UP explica a ausência', (await page.textContent('#up-note')).includes('não teve candidatura'));

  check('console sem erros', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  const mobile = await browser.newPage({viewport: {width: 390, height: 844}, isMobile: true});
  await mobile.goto(base + '#cargo=1&uf=MG&mun=54038');
  await mobile.waitForFunction(() => window.ATLAS_QA && window.ATLAS_QA.ready, null, {timeout: 60000});
  await mobile.waitForTimeout(500);
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('mobile 390px sem rolagem horizontal da página', overflow <= 0, `${overflow}px`);
  await mobile.screenshot({path: join(out, 'uberlandia-mobile.png')});
  await mobile.close();
} finally {
  await browser.close();
  server.kill();
  writeFileSync(join(out, 'resultado-testes.json'), JSON.stringify({at: new Date().toISOString(), results}, null, 2));
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações aprovadas`);
process.exit(failed.length ? 1 : 0);
