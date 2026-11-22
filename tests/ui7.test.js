import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

class Node {
  children = [];
  attributes = new Map();
  textContent = '';
  constructor(tag) { this.tag = tag; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  get lastElementChild() { return this.children.at(-1); }
  querySelectorAll() { return []; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  querySelector(selector) {
    assert.equal(selector, '.ad[aria-pressed="true"]');
    for (const child of this.children) {
      if (child.className === 'ad' && child.attributes.get('aria-pressed') === 'true') return child;
      const selected = child.querySelector(selector);
      if (selected) return selected;
    }
  }
}

const refDate = '2026-11-22';
const dataNote = 'Dữ liệu đến ngày 22/11 — ATC cập nhật quảng cáo hôm nay sau khoảng 20:00';
const ad = {
  creativeId: 'CR1', advertiserId: 'AR1', advertiserName: 'Example', domain: 'example.com',
  platform: 'search', format: 'image', image: 'images/CR1.png', firstShown: refDate, lastShown: refDate,
};
const groups = Array.from({ length: 7 }, (_, index) => ({
  key: index === 0 ? 'example.com' : 'example' + index + '.com',
  name: 'Dự án ' + index, groupType: 'domain', status: ['new', 'increase', 'decrease', 'stopped', 'steady'][index] ?? 'steady',
  runningNow: index === 3 ? 0 : index, runningPrev: index === 3 ? 3 : 0,
  delta: index === 3 ? -3 : index, newAds: index === 0 ? 1 : 0, totalAds: index + 1,
  firstShown: refDate, regions: [{ regionId: 2704, iso: 'VN', running: 1 }], sampleAds: [ad], followed: index !== 0,
}));
const advertiser = { ...groups[0], key: 'AR1', name: 'Example', groupType: 'advertiser' };
const points = [{ date: '2026-11-21', running: 0, newAds: 0 }, { date: refDate, running: 1, newAds: 1 }];
const watches = [
  { watchId: 'rival', label: 'Đối thủ A', kind: 'competitor', groupType: 'domain', groups },
  { watchId: 'project', label: 'Dự án A', kind: 'project', groupType: 'advertiser', groups: [advertiser] },
].map((watch) => ({
  ...watch, lastScanAt: refDate, runningNow: 2, runningPrev: 1, delta: 1, newAds: 1, newGroups: 1,
  spark: Array.from({ length: 30 }, (_, index) => ({
    running: index, date: new Date(Date.parse(refDate) - (29 - index) * 86_400_000).toISOString().slice(0, 10),
  })),
}));

class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-11-21T18:00:00Z'])); }
}

async function boot({ reply, storage = new Map(), initialStatus = { scanning: false, scanningWatchId: null, last: null } } = {}) {
  const nodes = new Map();
  const timers = new Map();
  const requests = [];
  let status = initialStatus;
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Node(id));
    return nodes.get(id);
  };
  get('profile').value = 'dai';
  get('watch-form').elements = { input: new Node('input') };
  get('detail').parentElement = new Node('section');
  get('gallery').children = ['ads', 'overview-watches', 'watch-groups'].map(get);
  get('filter').value = 'all';
  get('query').value = get('format').value = '';
  await runInNewContext(script, {
    URLSearchParams, Option: class {}, Date: TestDate,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    document: { getElementById: get, createElement: (tag) => new Node(tag),
      createElementNS: (_, tag) => new Node(tag), querySelectorAll: () => [] },
    setTimeout(callback, delay) {
      const id = Symbol();
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    async fetch(path, options) {
      const url = new URL(path, 'http://localhost');
      const body = options.body && JSON.parse(options.body);
      const request = { url, method: options.method, body };
      requests.push(request);
      const success = (data) => ({ ok: true, json: async () => data });
      const override = reply?.(request);
      if (override !== undefined) return override;
      switch (url.pathname.split('/').at(-1)) {
        case 'profiles': return success([{ id: 'dai', name: 'Dai' }]);
        case 'watchlist': return success(watches.map(({ watchId: id, label, kind }) => ({ id, label, kind })));
        case 'summary': return success({
          refDate, prevDate: '2026-11-21', window: url.searchParams.get('window'), dataNote, lastScan: null,
          totals: { newProjects: 1, newAdvertisers: 1, newAds: 2, increased: 1, decreased: 1, stopped: 1, runningAds: 4 },
          watches,
        });
        case 'series': return success({ refDate, points });
        case 'ads': return success([ad, { ...ad, creativeId: 'CR2', platform: 'display' }]);
        case 'suggest': return success([{ type: 'advertiser', value: 'AR1', name: 'Example', ads: 1 }]);
        case 'status': return success(status);
        case 'scan':
          status = { ...status, scanning: true, scanningWatchId: body.watchId ?? null };
          return { ok: true, status: 202 };
        default: throw new Error(path);
      }
    },
  });
  assert.equal(get('error').hidden, true);
  const rows = () => get('overview-watches').children[0].children[1].children;
  const advance = (delay) => {
    const [id, { callback }] = [...timers].find(([, timer]) => timer.delay === delay);
    timers.delete(id);
    return callback();
  };
  return { get, rows, requests, timers, advance, setStatus: (next) => { status = next; } };
}

const toggle = (row) => row.children[0].children[0];
const groupToggle = (wrapper) => wrapper.children[0].children[0];

test('overview selects the period, displays the seven totals and expands only five groups initially', async () => {
  const { get, rows, requests } = await boot();
  assert.equal(get('gallery-summary').textContent, dataNote);
  assert.equal(requests.find(({ url }) => url.pathname.endsWith('/summary')).url.searchParams.get('window'), 'day');
  await get('period').onchange({ currentTarget: { value: '30d' } });
  assert.equal(requests.at(-1).url.searchParams.get('window'), '30d');
  assert.deepEqual(get('totals').children.map((card) => card.children[0].textContent),
    ['Dự án mới', 'Nhà QC mới', 'Ads mới', 'Tăng', 'Giảm', 'Đã dừng', 'Ads đang chạy']);
  assert.equal(rows()[1].hidden, true);
  assert.equal(rows()[0].children[2].textContent, '2 (+1)');
  assert.equal(rows()[0].children[4].children[0].children[0].attributes.get('points').split(' ').length, 30);
  toggle(rows()[0]).onclick();
  const panel = rows()[1].children[0];
  assert.equal(panel.children.length, 6);
  assert.equal(panel.lastElementChild.textContent, 'Xem thêm');
  panel.lastElementChild.onclick();
  assert.equal(panel.children.length, 8);
  assert.equal(panel.lastElementChild.textContent, 'Thu gọn');
  get('totals').children[1].onclick();
  assert.equal(rows().length, 2);
  toggle(rows()[0]).onclick();
  assert.equal(groupToggle(rows()[1].children[0].children[0]).children[0].children[1].textContent, 'Example');
  get('totals').children[2].onclick();
  assert.equal(rows().length, 4);
});

test('watch page sorts groups, plots running and new ads, and preserves the filtered grid', async () => {
  const { get, requests } = await boot();
  await get('watches-competitor').children[0].children[0].onclick();
  assert.equal(get('grid-view').hidden, true);
  assert.equal(get('watch-groups').children.length, 7);
  const [legend, chart, readout] = get('watch-chart').children;
  assert.deepEqual(legend.children.map((entry) => entry.textContent), ['Đang chạy', 'Ads mới']);
  assert.equal(chart.children.filter((node) => node.attributes.get('class') === 'chart-bar').length, 2);
  chart.children.at(-1).onmouseenter();
  assert.equal(readout.textContent, '22/11 · 1 đang chạy · 1 ads mới');
  get('group-sort').value = 'name';
  get('group-sort').onchange();
  const first = get('watch-groups').children[0];
  assert.equal(groupToggle(first).children[0].children[1].textContent, 'Dự án 0');
  await groupToggle(first).onclick();
  assert.equal(first.children[1].children[1].children[0].children[0].src, '/images/CR1.png');
  const seriesRequests = requests.filter(({ url }) => url.pathname.endsWith('/series'));
  assert.equal(seriesRequests[0].url.searchParams.get('watchId'), 'rival');
  assert.equal(seriesRequests[0].url.searchParams.get('days'), '90');
  assert.equal(seriesRequests[1].url.searchParams.get('group'), 'example.com');
  await get('mode-grid').onclick();
  assert.equal(get('group-view').hidden, true);
  assert.equal(get('grid-view').hidden, false);
  assert.equal(get('ads').children.length, 1);
  get('query').value = 'example';
  await get('query').oninput();
  assert.equal(requests.findLast(({ url }) => url.pathname.endsWith('/ads')).url.searchParams.get('q'), 'example');
});

test('suggestions debounce and add with the chosen kind, including pasted links and group follow', async () => {
  const { get, rows, requests, advance, timers } = await boot();
  const form = get('watch-form');
  const input = form.elements.input;
  input.value = 'Ex';
  input.oninput();
  input.value = 'Example';
  input.oninput();
  assert.equal([...timers.values()].filter(({ delay }) => delay === 250).length, 1);
  await advance(250);
  assert.equal(requests.at(-1).url.searchParams.get('q'), 'Example');
  get('kind-project').onclick();
  await get('suggestions').children[0].onclick();
  const link = 'https://adstransparency.google.com/advertiser/AR1/creative/CR1?region=VN';
  input.value = link;
  get('kind-competitor').onclick();
  await form.onsubmit({ preventDefault() {} });
  toggle(rows()[0]).onclick();
  await rows()[1].children[0].children[0].children[0].children[1].onclick();
  toggle(rows()[2]).onclick();
  await rows()[3].children[0].children[0].children[0].children[1].onclick();
  assert.deepEqual(requests.filter(({ method }) => method === 'POST').map(({ body }) => body), [
    { input: 'AR1', kind: 'project', region: null }, { input: link, kind: 'competitor', region: null },
    { input: 'example.com', kind: 'project', region: null }, { input: 'AR1', kind: 'competitor', region: null },
  ]);
});

test('scan buttons target the correct scope and poll through Vietnamese statuses', async () => {
  const { get, rows, requests, setStatus, advance } = await boot();
  await rows()[0].children[5].children[0].onclick();
  assert.equal(get('status').textContent, 'Đang quét Đối thủ A…');
  assert.equal(get('scan').disabled, true);
  setStatus({ scanning: false, scanningWatchId: null, last: { status: 'ok' } });
  await advance(5000);
  assert.equal(get('status').textContent, 'Hoàn tất');
  await get('watches-project').children[0].children[1].onclick();
  assert.equal(get('status').textContent, 'Đang quét Dự án A…');
  setStatus({ scanning: false, last: { status: 'blocked' } });
  await advance(5000);
  assert.equal(get('status').textContent, 'Bị Google chặn');
  await get('watches-competitor').children[0].children[0].onclick();
  await get('scan-watch').onclick();
  setStatus({ scanning: false, last: { status: 'cooldown', resumeAt: '2026-11-22T13:45:00Z' } });
  await advance(5000);
  assert.equal(get('status').textContent, 'Đang nghỉ · quét lại lúc 20:45');
  await get('scan').onclick();
  assert.deepEqual(requests.filter(({ method }) => method === 'POST').map(({ body }) => body),
    [{ watchId: 'rival' }, { watchId: 'project' }, { watchId: 'rival' }, {}]);
});

test('a scan conflict displays the active watch without retrying the POST', async () => {
  const { get, requests, setStatus } = await boot({
    reply: ({ method, url }) => method === 'POST' && url.pathname === '/api/scan'
      ? { ok: false, status: 409, json: async () => ({ error: 'Đang có lượt quét.' }) }
      : undefined,
  });
  setStatus({ scanning: true, scanningWatchId: 'project', last: null });
  await get('scan').onclick();
  assert.equal(get('status').textContent, 'Đang quét Dự án A…');
  assert.equal(requests.filter(({ method }) => method === 'POST').length, 1);
});

test('late group results cannot reopen a collapsed group', async () => {
  let resolveAds;
  const delayed = new Promise((resolve) => { resolveAds = resolve; });
  const { rows } = await boot({
    reply: ({ url }) => url.pathname.endsWith('/ads') && url.searchParams.has('group') ? delayed : undefined,
  });
  toggle(rows()[0]).onclick();
  const [controls, panel] = rows()[1].children[0].children[0].children;
  const row = controls.children[0];
  const request = row.onclick();
  row.onclick();
  resolveAds({ ok: true, json: async () => [ad] });
  await request;
  assert.equal(panel.hidden, true);
  assert.equal(panel.children.length, 0);
});

test('the grid still shows dates and opens advertisement details', async () => {
  const { get } = await boot({
    reply: ({ url }) => url.pathname.endsWith('/ads')
      ? { ok: true, json: async () => [
        { ...ad, imageUrl: 'https://example.com/remote.png' },
        { ...ad, creativeId: 'CR2', image: null, imageUrl: 'https://example.com/remote.png' },
        { ...ad, creativeId: 'CR3', image: null, firstShown: '2026-11-20', lastShown: '2026-11-21' },
      ] } : undefined,
  });
  await get('watches-competitor').children[0].children[0].onclick();
  await get('mode-grid').onclick();
  const [local, remote, fallback] = get('ads').children;
  assert.equal(local.children[0].src, '/images/CR1.png');
  assert.equal(remote.children[0].src, 'https://example.com/remote.png');
  assert.equal(fallback.children[0].children[1].textContent, 'Chưa có ảnh xem trước');
  const [, , dates, badges] = fallback.children[1].children;
  assert.equal(dates.textContent, 'Bắt đầu 20/11/2026 · Gần nhất 21/11/2026');
  assert.deepEqual(badges.children.map((badge) => badge.className), ['badge tone-stopped']);
  assert.equal(local.children[1].children[3].children[0].className, 'badge tone-new');
  local.onclick();
  assert.equal(get('detail').children[1].children[1].textContent, 'Example');
  remote.onclick();
  assert.equal(local.attributes.get('aria-pressed'), 'false');
});

test('Vietnamese date ranges filter grids and groups by overlap and survive reload', async () => {
  const storage = new Map();
  const spanning = {
    ...ad, domain: 'WWW.EXAMPLE.COM.', firstShown: '2026-11-10',
    lastShown: '2026-11-21T17:00:00Z',
  };
  const older = {
    ...ad, creativeId: 'CR2', domain: 'example1.com',
    firstShown: '2026-11-01', lastShown: '2026-11-21T16:59:59Z',
  };
  const recent = { ...ad, creativeId: 'CR3', domain: 'example1.com', firstShown: '2026-11-16', lastShown: '2026-11-16' };
  const earliest = { ...ad, creativeId: 'CR4', domain: 'example1.com', firstShown: '2026-10-24', lastShown: '2026-10-24' };
  const undated = { ...ad, creativeId: 'CR5', firstShown: null };
  const reply = ({ url }) => {
    if (!url.pathname.endsWith('/ads')) return;
    assert.equal(url.searchParams.get('watchId'), 'rival');
    assert.deepEqual([...url.searchParams.keys()].filter((key) => ['from', 'to', 'window'].includes(key)), []);
    const all = [spanning, older, recent, earliest, undated];
    return { ok: true, json: async () => url.searchParams.has('group') ? [spanning, undated] : all };
  };
  const { get } = await boot({ storage, reply });
  const choose = (page) => page('watches-competitor').children[0].children[0].onclick();
  await choose(get);
  const period = get('ad-period');
  const select = async (value) => {
    period.value = value;
    await period.onchange();
  };
  assert.equal(get('watch-groups').children.length, 7);
  await select('today');
  assert.equal(get('watch-groups').children.length, 1);
  const wrapper = get('watch-groups').children[0];
  await groupToggle(wrapper).onclick();
  assert.equal(wrapper.children[1].children[1].children.length, 1);
  await get('mode-grid').onclick();
  assert.equal(get('ads').children.length, 1);
  await select('7d');
  assert.equal(get('ads').children.length, 3);
  await select('30d');
  assert.equal(get('ads').children.length, 4);
  await select('all');
  assert.equal(get('ads').children.length, 5);
  await select('custom');
  assert.equal(get('ad-dates').hidden, false);
  get('ad-from').value = get('ad-to').value = '2026-11-22';
  await get('ad-to').onchange();
  assert.equal(get('ads').children.length, 1);
  const reloaded = await boot({ storage, reply });
  await choose(reloaded.get);
  assert.equal(reloaded.get('ad-period').value, 'custom');
  assert.equal(reloaded.get('ad-from').value, '2026-11-22');
  assert.equal(reloaded.get('ad-to').value, '2026-11-22');
  assert.equal(reloaded.get('watch-groups').children.length, 1);
});
