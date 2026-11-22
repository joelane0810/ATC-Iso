import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const readWeb = (file) => readFileSync(new URL('../web/' + file, import.meta.url), 'utf8');
const app = readWeb('app.js');
const css = readWeb('style.css');
const html = readWeb('index.html');

function renderRows(label, allTime = false) {
  const element = (tag, textContent = '') => ({
    tag, textContent, children: [], attributes: {},
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  const source = (start, end) => app.slice(app.indexOf('function ' + start), app.indexOf('function ' + end));
  const expandedWatches = new Set();
  const fills = [];
  const context = {
    element, expandedWatches, watchColors: ['purple'], kindOf: () => 'competitor',
    kindLabels: { competitor: 'Nhà quảng cáo' }, formatCount: new Intl.NumberFormat('vi'),
    signed: String, totalWatchAds: () => 40, sparkline: () => element('svg'),
    scanButton: (text, id, label) => {
      const button = element('button', text);
      button.setAttribute('aria-label', label);
      return button;
    },
    closeGroup() {}, showDetail() {},
    fillOverviewGroups: (panel) => fills.push(panel),
    watch: { watchId: 'test', label, runningNow: 27, newAds: 0, delta: 0 },
    allTime,
  };
  const [, row, expansion] = runInNewContext(
    source('watchName(', 'badge(') + source('overviewWatchRows(', 'fillOverviewGroups(')
      + 'overviewWatchRows(watch, [], allTime ? 5 : 6, allTime)',
    context,
  );
  return { row, expansion, fills };
}

test('the overview card keeps names intact and has labeled metrics, a trend, and a scan control', () => {
  const label = 'South Wind Tech Limited';
  const { row, expansion, fills } = renderRows(label);
  assert.equal(row.className, 'overview-card');
  const [name, kind, running, recent, trend, scan] = row.children;
  assert.deepEqual(row.children.map((cell) => cell.className), [
    'overview-name-cell', 'overview-kind-cell', 'overview-running-cell',
    'overview-new-cell', 'overview-trend-cell', 'overview-scan-cell',
  ]);
  const [toggle] = name.children;
  const [, watchName] = toggle.children;
  const [dot, text] = watchName.children;
  assert.equal(dot.className, 'watch-dot');
  assert.equal(text.textContent, label);
  assert.equal(text.className, 'item-name');
  assert.equal(kind.children[0].textContent, 'Nhà quảng cáo');
  const [count, delta] = running.children[0].children;
  assert.equal(count.attributes['data-label'], 'đang chạy');
  assert.equal(delta.attributes['data-label'], ' (±');
  assert.equal(recent.attributes['data-label'], 'mới');
  assert.equal(trend.children[0].tag, 'svg');
  assert.equal(scan.children[0].attributes['data-label'], '⟳');
  assert.equal(scan.children[0].attributes['aria-label'], 'Quét ' + label);

  assert.equal(expansion.hidden, true);
  toggle.onclick();
  assert.equal(expansion.hidden, false);
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  assert.equal(fills.length, 1);
  toggle.onclick();
  assert.equal(expansion.hidden, true);
});

test('historical cards show their total and permit long unspaced names to wrap', () => {
  const { row } = renderRows('syntx.ai', true);
  assert.equal(row.className, 'overview-card');
  assert.equal(row.children[0].children[0].children[1].children[1].className, 'item-name unspaced-name');
  assert.equal(row.children[2].attributes['data-label'], 'ads trong dữ liệu');
  assert.ok(row.children.every((cell) => cell.className !== 'overview-trend-cell'));
  assert.match(css, /\.item-name\s*\{[^}]*word-break:\s*normal;[^}]*overflow-wrap:\s*normal;/);
  assert.match(css, /\.item-name\.unspaced-name\s*\{\s*overflow-wrap:\s*anywhere;/);
});

test('phone and tablet rules define compact card grids and a scrolling date strip', () => {
  assert.match(css, /\.totals\.overview-totals\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /\.overview-total\s*\{[^}]*min-height:\s*48px/);
  assert.match(css, /@media \(width >= 1280px\)\s*\{\s*\.totals\.overview-totals\s*\{\s*grid-template-columns:\s*minmax\(0, 3fr\) minmax\(0, 7fr\)/);
  assert.match(css, /\.overview-table thead\s*\{\s*display:\s*none;/);
  assert.match(css, /\.overview-table \.overview-card\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(css, /\.range-options\s*\{[^}]*overflow-x:\s*auto;/);
  assert.match(html, /class="range-options">\s*<button id="range-open"[\s\S]*?id="range-chips"[\s\S]*?<\/div>\s*<\/div>\s*<span id="comparison"/);
  assert.match(html, /viewport-fit=cover/);
  assert.equal([...app.matchAll(/(?:card|button)\.setAttribute\('data-label', label\)/g)].length, 3);
});
