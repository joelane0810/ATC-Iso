import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const sidebarRow = (get, kind) =>
  get('watches-' + kind).children.at(-1).children[0].children[1].children[0].children[0];

const script = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

class Node {
  children = [];
  attributes = new Map();
  textContent = '';
  style = {};
  offsetTop = 0;
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return { left: 10, width: 350 }; }
  dispatchEvent(event) { this['on' + event.type]?.(event); }
  constructor(tag) { this.tag = tag; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  get firstElementChild() { return this.children[0]; }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
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

const minDate = '2026-09-15';
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
  static now() { return +new TestDate(); }
  constructor(...args) { super(...(args.length ? args : ['2026-11-21T18:00:00Z'])); }
}

async function boot({ reply, browser = {}, dates = { refDate, minDate }, storage = new Map(), initialStatus = { scanning: false, scanningWatchId: null, last: null } } = {}) {
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
    ...browser,
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
        case 'groups': case 'trash': return success([]);
        case 'profiles': return success([{ id: 'dai', name: 'Dai' }]);
        case 'watchlist': return success(watches.map(({ watchId: id, label, kind }) => ({ id, label, kind })));
        case 'summary': return success({
          ...dates, prevDate: '2026-11-21', dataNote, lastScan: null,
          totals: { newProjects: 1, newAdvertisers: 1, newAds: 2, increased: 1, decreased: 1, stopped: 1, runningAds: 4 },
          watches,
        });
        case 'series': return success({ ...dates, points });
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
  const rows = () => get('overview-watches').children[0].children[1].children.filter((row) => row.className !== 'overview-folder');
  const advance = (delay) => {
    const [id, { callback }] = [...timers].find(([, timer]) => timer.delay === delay);
    timers.delete(id);
    return callback();
  };
  return { get, rows, requests, timers, advance, setStatus: (next) => { status = next; } };
}

const toggle = (row) => row.children[0].children[0];
const selectRange = (get, from, to) => {
  get('range-open').onclick();
  get('range-from').value = from;
  get('range-to').value = to;
  return get('range-form').onsubmit({ preventDefault() {} });
};
const submitRange = (get) => get('range-form').onsubmit({ preventDefault() {} });
const chooseAllTime = (get) => {
  get('range-open').onclick();
  get('range-presets').children.at(-1).onclick();
  return submitRange(get);
};
const latestParams = (requests, endpoint) =>
  requests.findLast(({ url }) => url.pathname.endsWith('/' + endpoint)).url.searchParams;
const groupToggle = (wrapper) => wrapper.children[0].children[0];

test('overview selects the period, displays the seven totals and expands only five groups initially', async () => {
  const { get, rows, requests } = await boot();
  assert.equal(get('gallery-summary').textContent, dataNote);
  assert.equal(get('range-value').textContent, 'Hôm nay');
  await selectRange(get, '24 thg 10, 2026', '22 thg 11, 2026');
  const params = latestParams(requests, 'summary');
  assert.equal(params.get('from'), '2026-10-24');
  assert.equal(params.get('to'), refDate);
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
  await sidebarRow(get, 'competitor').children[0].onclick();
  assert.equal(get('grid-view').hidden, true);
  assert.equal(get('watch-groups').children.length, 7);
  const checkChart = (container) => {
    const [, plot, table] = container.children;
    const [chart, tooltip] = plot.children;
    const labels = table.children[0].children[0].children.map((entry) => entry.textContent);
    assert.deepEqual(labels, ['Ngày', 'Ads đang chạy', 'Ads mới']);
    assert.ok(chart.children.some((node) => node.attributes.get('class') === 'chart-line'));
    assert.equal(chart.children.filter((node) => node.attributes.get('class') === 'chart-bar').length, 2);
    const [, line, hit] = chart.children.slice(-3);
    assert.equal(line.attributes.get('visibility'), 'hidden');
    assert.equal(tooltip.hidden, true);
    for (const clientY of [50, 120]) {
      hit.dispatchEvent({ type: 'pointermove', clientX: 272, clientY });
      assert.equal(tooltip.hidden, false);
      assert.equal(tooltip.textContent, '22/11/2026\nAds đang chạy: 1\nAds mới: 1');
      assert.equal(line.attributes.get('visibility'), 'visible');
      assert.equal(line.attributes.get('x1'), '261.5');
      assert.equal(line.attributes.get('x2'), '261.5');
      assert.equal(line.attributes.get('y1'), '30');
      assert.equal(line.attributes.get('y2'), '248');
      hit.dispatchEvent({ type: 'pointerleave' });
      assert.equal(tooltip.hidden, true);
      assert.equal(line.attributes.get('visibility'), 'hidden');
    }
  };
  checkChart(get('watch-chart'));
  get('group-sort').value = 'name';
  get('group-sort').onchange();
  const first = get('watch-groups').children[0];
  assert.equal(groupToggle(first).children[0].children[0].textContent, 'Dự án 0');
  await groupToggle(first).onclick();
  checkChart(first.children[1].children[0]);
  assert.equal(first.children[1].children[1].children[0].children[0].src, '/images/CR1.png');
  const seriesRequests = requests.filter(({ url }) => url.pathname.endsWith('/series'));
  assert.equal(seriesRequests[0].url.searchParams.get('watchId'), 'rival');
  assert.equal(seriesRequests[0].url.searchParams.get('days'), null);
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
    { input: 'AR1', kind: 'project', region: null, groupId: null }, { input: link, kind: 'competitor', region: null, groupId: null },
    { input: 'example.com', kind: 'project', region: null, groupId: null }, { input: 'AR1', kind: 'competitor', region: null, groupId: null },
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
  await sidebarRow(get, 'project').children[1].onclick();
  assert.equal(get('status').textContent, 'Đang quét Dự án A…');
  setStatus({ scanning: false, last: { status: 'blocked' } });
  await advance(5000);
  assert.equal(get('status').textContent, 'Bị Google chặn');
  await sidebarRow(get, 'competitor').children[0].onclick();
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
  await sidebarRow(get, 'competitor').children[0].onclick();
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
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const localDay = (value) => value && new Date(Date.parse(value) + 7 * 3_600_000).toISOString().slice(0, 10);
    const all = url.searchParams.has('group') ? [spanning, undated] : [spanning, older, recent, earliest, undated];
    const visible = from ? all.filter(({ firstShown, lastShown }) =>
      firstShown && localDay(firstShown) <= to && localDay(lastShown) >= from) : all;
    return { ok: true, json: async () => visible };
  };
  const { get, requests } = await boot({ storage, reply });
  const choose = (page) => sidebarRow(page, 'competitor').children[0].onclick();
  await choose(get);
  assert.equal(get('range-value').textContent, 'Mọi lúc');
  assert.equal(get('watch-groups').children.length, 7);
  await selectRange(get, '22 thg 11, 2026', '22 thg 11, 2026');
  const wrapper = get('watch-groups').children.find((row) =>
    groupToggle(row).children[0].lastElementChild.textContent === 'Dự án 0');
  await groupToggle(wrapper).onclick();
  assert.equal(wrapper.children[1].children[1].children.length, 1);
  assert.equal(latestParams(requests, 'ads').get('group'), 'example.com');
  await get('mode-grid').onclick();
  assert.equal(get('ads').children.length, 1);
  await selectRange(get, '16 thg 11, 2026', '22 thg 11, 2026');
  assert.equal(get('ads').children.length, 3);
  await selectRange(get, '24 thg 10, 2026', '22 thg 11, 2026');
  assert.equal(get('ads').children.length, 4);
  assert.equal(latestParams(requests, 'ads').get('from'), '2026-10-24');
  assert.equal(latestParams(requests, 'ads').get('to'), refDate);
  assert.equal(latestParams(requests, 'ads').get('window'), null);

  const reloaded = await boot({ storage, reply });
  await choose(reloaded.get);
  assert.equal(reloaded.get('range-value').textContent, '30 ngày qua');
  await reloaded.get('mode-grid').onclick();
  assert.equal(reloaded.get('ads').children.length, 4);
  await chooseAllTime(reloaded.get);
  assert.equal(reloaded.get('ads').children.length, 5);
});

test('all time displays historical totals and latest-day counts without comparisons', async () => {
  const { get, rows, requests } = await boot();
  get('totals').children[1].onclick();
  await chooseAllTime(get);
  assert.equal(get('range-value').textContent, 'Mọi lúc');
  assert.equal(get('comparison-note').hidden, false);
  assert.equal(get('comparison').textContent, '');
  assert.deepEqual(get('totals').children.map((card) => card.children.map((child) => child.textContent)), [
    ['Tổng ads trong dữ liệu', '29'], ['Ads đang chạy (ngày dữ liệu mới nhất)', '4'],
  ]);
  assert.deepEqual(rows()[0].children.slice(2, 4).map((cell) => cell.textContent), ['28', '2']);
  toggle(rows()[0]).onclick();
  const [heading, counts] = groupToggle(rows()[1].children[0].children[0]).children;
  assert.deepEqual(heading.children.map((child) => child.textContent), ['Dự án 0']);
  assert.deepEqual(counts.children.map((child) => child.textContent), [
    'Tổng ads trong dữ liệu 1', 'Ads đang chạy (ngày dữ liệu mới nhất) 0',
  ]);
  await sidebarRow(get, 'competitor').children[0].onclick();
  assert.equal(latestParams(requests, 'summary').get('from'), null);
  assert.equal(get('watch-groups').children.length, 7);
  assert.ok(get('watch-groups').children.every((row) => groupToggle(row).children[0].children.length === 1));
});

test('the calendar opens at the selected start month and keeps every month scrollable', async () => {
  const { get } = await boot({
    storage: new Map([['atc-iso-date-range', JSON.stringify({ from: '2026-10-15', to: refDate })]]),
  });
  const calendar = get('calendar-months');
  const replaceChildren = calendar.replaceChildren.bind(calendar);
  calendar.replaceChildren = (...months) => {
    months.forEach((month, index) => { month.offsetTop = index * 300; });
    replaceChildren(...months);
  };
  get('range-open').onclick();
  assert.deepEqual(calendar.children.map((month) => month.children[0].textContent),
    ['THG 9 2026', 'THG 10 2026', 'THG 11 2026']);
  assert.equal(get('calendar-title').textContent, 'THG 10 2026');
  assert.equal(calendar.scrollTop, 300);
  calendar.scrollTop = 600;
  calendar.onscroll();
  assert.equal(get('calendar-title').textContent, 'THG 11 2026');
  calendar.scrollTop = 0;
  calendar.onscroll();
  assert.equal(get('calendar-title').textContent, 'THG 9 2026');
});

const presetLabels = ['Hôm nay', 'Hôm qua', '7 ngày qua', '30 ngày qua', 'Tháng này', 'Tháng trước', 'Mọi lúc'];
const chipLabels = ['Hôm nay', 'Hôm qua', '7 ngày', '30 ngày', 'Tháng này', 'Tháng trước'];
const inputDate = (date) => {
  const [year, month, day] = date.split('-');
  return Number(day) + ' thg ' + Number(month) + ', ' + year;
};

for (const { dates, expected } of [
  {
    dates: { refDate, minDate },
    expected: [
      [refDate, refDate], ['2026-11-21', '2026-11-21'],
      ['2026-11-16', refDate], ['2026-10-24', refDate],
      ['2026-11-01', refDate], ['2026-10-01', '2026-10-31'], [minDate, refDate],
    ],
  },
  {
    dates: { refDate: '2024-03-01', minDate: '2024-01-01' },
    expected: [
      ['2024-03-01', '2024-03-01'], ['2024-02-29', '2024-02-29'],
      ['2024-02-24', '2024-03-01'], ['2024-02-01', '2024-03-01'],
      ['2024-03-01', '2024-03-01'], ['2024-02-01', '2024-02-29'], ['2024-01-01', '2024-03-01'],
    ],
  },
  {
    dates: { refDate: '2026-11-01', minDate: '2026-11-01' },
    expected: presetLabels.map(() => ['2026-11-01', '2026-11-01']),
  },
  {
    dates: { refDate: '2026-01-03', minDate: '2025-12-28' },
    expected: [
      ['2026-01-03', '2026-01-03'], ['2026-01-02', '2026-01-02'],
      ['2025-12-28', '2026-01-03'], ['2025-12-28', '2026-01-03'],
      ['2026-01-01', '2026-01-03'], ['2025-12-28', '2025-12-31'], ['2025-12-28', '2026-01-03'],
    ],
  },
]) {
  test('quick ranges use API dates ' + dates.minDate + ' to ' + dates.refDate, async () => {
    const { get, requests } = await boot({ dates });
    const presets = get('range-presets').children;
    const chips = get('range-chips').children;
    assert.deepEqual(presets.map(({ textContent }) => textContent), presetLabels);
    assert.deepEqual(chips.map(({ textContent }) => textContent), chipLabels);
    const calendar = get('calendar-months');
    const replaceChildren = calendar.replaceChildren.bind(calendar);
    calendar.replaceChildren = (...months) => {
      months.forEach((month, index) => { month.offsetTop = index * 300; });
      replaceChildren(...months);
    };
    const checkApplied = (index, endpoint = 'summary') => {
      const params = latestParams(requests, endpoint);
      const [from, to] = expected[index];
      const allTime = index === presetLabels.length - 1;
      assert.deepEqual([params.get('from'), params.get('to')], allTime ? [null, null] : [from, to]);
      assert.equal(get('range-value').textContent, presetLabels[index]);
      assert.equal(get('range-dialog').open, false);
      assert.deepEqual(chips.map((chip) => chip.attributes.get('aria-pressed')),
        chips.map((_, chipIndex) => String(chipIndex === index)));
    };
    for (const [index, [from, to]] of expected.entries()) {
      get('range-open').onclick();
      const requestCount = requests.length;
      const oldLabel = get('range-value').textContent;
      const preset = presets[index];
      preset.onclick();
      assert.equal(get('range-dialog').open, true);
      assert.equal(requests.length, requestCount);
      assert.equal(get('range-value').textContent, oldLabel);
      assert.equal(get('range-from').value, inputDate(from));
      assert.equal(get('range-to').value, inputDate(to));
      assert.equal(preset.attributes.get('aria-pressed'), 'true');
      const day = (date) => calendar.children.flatMap((month) => month.children[1].children)
        .find((node) => node.attributes.get('aria-label') === inputDate(date));
      assert.match(day(from).className, /in-range range-start/);
      assert.match(day(to).className, /in-range .*range-end/);
      const [year, month] = from.split('-');
      const title = 'THG ' + Number(month) + ' ' + year;
      assert.equal(get('calendar-title').textContent, title);
      assert.equal(calendar.scrollTop, calendar.children.find((entry) => entry.children[0].textContent === title).offsetTop);
      await submitRange(get);
      checkApplied(index);
    }
    get('range-open').onclick();
    presets[0].onclick();
    get('range-cancel').onclick();
    checkApplied(presetLabels.length - 1);
    for (const [index, chip] of chips.entries()) {
      await chip.onclick();
      checkApplied(index);
    }

    await sidebarRow(get, 'competitor').children[0].onclick();
    await get('mode-grid').onclick();
    await chips[2].onclick();
    for (const endpoint of ['summary', 'series', 'ads']) checkApplied(2, endpoint);
  });
}

function managedProfile({ folders = [], items = [], series = points } = {}) {
  let groups = folders.map((folder) => ({ ...folder }));
  let active = watches.map(({ watchId: id, label, kind }) => ({ id, label, kind, groupId: null }));
  let trash = items.map((item) => ({ ...item }));
  const reply = ({ url, method, body }) => {
    const [, resource, id] = /^\/api\/profiles\/dai\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname) ?? [];
    const ok = (data) => ({ ok: true, json: async () => data });
    const remove = (ids) => {
      trash.push(...active.filter((watch) => ids.includes(watch.id)).map(({ id: watchId, ...watch }) => ({
        ...watch, watchId, deletedAt: '2026-11-21T18:00:00Z', purgeAt: '2027-01-20T18:00:00Z',
      })));
      active = active.filter((watch) => !ids.includes(watch.id));
    };
    if (resource === 'groups') {
      if (method === 'POST') groups.push({ id: 'created', ...body });
      if (method === 'PATCH') Object.assign(groups.find((group) => group.id === id), body);
      if (method === 'DELETE') {
        groups = groups.filter((group) => group.id !== id);
        for (const watch of [...active, ...trash]) if (watch.groupId === id) watch.groupId = null;
      }
      return ok(groups.map((group) => ({ ...group })));
    }
    if (resource === 'watchlist') {
      if (method === 'POST' && id === 'delete') remove(body.ids);
      else if (method === 'DELETE') remove([id]);
      else if (method === 'PATCH') Object.assign(active.find((watch) => watch.id === id), body);
      else if (method === 'POST') {
        const previous = trash.find(({ value, kind }) => value === body.input && kind === body.kind);
        trash = trash.filter((item) => item !== previous);
        active.push({ id: previous?.watchId ?? body.input, label: previous?.label ?? body.input,
          value: body.input, kind: body.kind, groupId: body.groupId });
      }
      return ok(active.map((watch) => ({ ...watch })));
    }
    if (resource === 'trash') {
      if (id === 'restore') {
        active.push(...trash.filter(({ watchId }) => body.ids.includes(watchId))
          .map(({ watchId, deletedAt, purgeAt, ...data }) => ({ id: watchId, ...data })));
      }
      if (id) trash = trash.filter(({ watchId }) => !body.ids.includes(watchId));
      return ok(trash.map((item) => ({ ...item })));
    }
    if (resource === 'summary') return ok({
      refDate, minDate, totals: {}, watches: watches.filter(({ watchId }) => active.some(({ id }) => id === watchId)),
    });
    if (resource === 'series') return ok({ refDate, minDate, points: series });
  };
  return { reply };
}

const action = (node, label) => node.children.find((child) => child.tag === 'button' && child.textContent === label);
const requestCount = (requests, method) => requests.filter((request) => request.method === method).length;
const sidebarFolder = (get, kind, index) => get('watches-' + kind).children.at(index);
const folderItems = (folder) => folder.children[0].children[1].children;
const check = (box) => { box.checked = true; box.onchange(); };
const trashActions = (get) => get('trash-content').children[0];
const trashItems = (get) => get('trash-content').children[1].children;
const submitName = async (form, name) => {
  form.children[0].value = name;
  await form.onsubmit({ preventDefault() {} });
};

test('single watch deletion confirms in place, can be cancelled, and can be undone for eight seconds', async () => {
  const { get, requests, timers, advance, rows } = await boot(managedProfile());
  const watch = () => folderItems(sidebarFolder(get, 'competitor', -1))[0];
  action(watch().children[0], '×').onclick();
  assert.match(watch().children.at(-1).children[0].textContent, /Chuyển Đối thủ A vào thùng rác\?/);
  action(watch().children.at(-1), 'Huỷ').onclick();
  assert.equal(requestCount(requests, 'DELETE'), 0);
  action(watch().children[0], '×').onclick();
  await action(watch().children.at(-1), 'Chuyển vào thùng rác').onclick();
  assert.equal(requests.find(({ method }) => method === 'DELETE').url.pathname, '/api/profiles/dai/watchlist/rival');
  assert.equal(watch(), undefined);
  assert.equal(rows().length, 2);
  assert.equal(get('trash-count').textContent, '1');
  const toast = get('undo-toast');
  assert.equal(toast.hidden, false);
  assert.ok([...timers.values()].some(({ delay }) => delay === 8000));
  await action(toast, 'Hoàn tác').onclick();
  assert.deepEqual(requests.find(({ method }) => method === 'POST').body, { ids: ['rival'] });
  assert.equal(get('trash-count').textContent, '0');
  assert.ok(watch());

  action(watch().children[0], '×').onclick();
  await action(watch().children.at(-1), 'Chuyển vào thùng rác').onclick();
  await advance(8000);
  assert.equal(toast.hidden, true);
});

test('bulk watch selection moves only selected watches and requires confirmation before trashing', async () => {
  const { get, requests } = await boot(managedProfile({ folders: [{ id: 'team', name: 'Nhóm A', kind: 'competitor' }] }));
  const toolbar = get('selection-competitor');
  get('select-competitor').onclick();
  assert.equal(action(toolbar, 'Chuyển vào thùng rác').disabled, true);
  check(sidebarRow(get, 'competitor').children[0]);
  assert.equal(toolbar.children[0].textContent, 'Đã chọn 1');
  action(toolbar, 'Chuyển vào nhóm…').onclick();
  await action(toolbar.children.at(-1), 'Nhóm A').onclick();
  assert.deepEqual(requests.find(({ method }) => method === 'PATCH').body, { groupId: 'team' });
  assert.equal(folderItems(sidebarFolder(get, 'competitor', 0)).length, 1);
  assert.equal(folderItems(sidebarFolder(get, 'project', -1)).length, 1);

  get('select-competitor').onclick();
  check(folderItems(sidebarFolder(get, 'competitor', 0))[0].children[0].children[0]);
  action(toolbar, 'Chuyển vào thùng rác').onclick();
  assert.equal(requestCount(requests, 'POST'), 0);
  await action(toolbar.children[4], 'Chuyển vào thùng rác').onclick();
  const deletion = requests.find(({ method }) => method === 'POST');
  assert.ok(deletion.url.pathname.endsWith('/watchlist/delete'));
  assert.deepEqual(deletion.body, { ids: ['rival'] });
});

test('folders support create, rename, same-kind drop, menu moves, retained watches and overview totals', async () => {
  const { get, requests } = await boot(managedProfile());
  get('new-group-competitor').onclick();
  await submitName(get('group-editor-competitor').children[0].children[0], 'Nhóm A');
  assert.deepEqual(requests.find(({ method }) => method === 'POST').body, { name: 'Nhóm A', kind: 'competitor' });
  const group = () => sidebarFolder(get, 'competitor', 0);
  const title = () => group().children[0].children[0];
  const drag = { dataTransfer: {
    types: ['application/x-atc-watch'],
    setData(type, id) { this[type] = id; },
    getData(type) { return this[type]; },
  }, preventDefault() {} };
  sidebarRow(get, 'project').ondragstart(drag);
  await group().children[0].ondrop(drag);
  assert.equal(requestCount(requests, 'PATCH'), 0);
  sidebarRow(get, 'competitor').ondragstart(drag);
  await group().children[0].ondrop(drag);
  assert.equal(title().textContent, 'Nhóm A · 1');
  assert.equal(sidebarFolder(get, 'competitor', -1).children[0].children[0].textContent, 'Không nhóm · 0');
  const body = get('overview-watches').children[0].children[1];
  const headings = body.children.filter((row) => row.className === 'overview-folder');
  const overview = headings[0].children[0].children[0];
  assert.match(overview.textContent, /Nhóm A · Đối thủ · 1 mục · 2 ads đang chạy · 1 ads mới/);
  overview.onclick();
  assert.equal(body.children[1].hidden, true);
  overview.onclick();
  assert.equal(body.children[1].hidden, false);

  const menu = () => {
    action(group(), '⋯').onclick();
    return group().children.at(-1).children[0];
  };
  let options = menu();
  action(options, 'Đổi tên').onclick();
  await submitName(options.children[2].children[0], 'Tên mới');
  assert.equal(title().textContent, 'Tên mới · 1');

  const item = folderItems(group())[0];
  action(item.children[0], '⋯').onclick();
  const move = item.children[1].children[0];
  action(move, 'Chuyển vào nhóm…').onclick();
  await action(move.children[1], 'Không nhóm').onclick();
  assert.equal(folderItems(group()).length, 0);
  sidebarRow(get, 'competitor').ondragstart(drag);
  await group().children[0].ondrop(drag);

  options = menu();
  action(options, 'Xoá nhóm (giữ các mục)').onclick();
  await action(options.children.at(-1), 'Xoá nhóm (giữ các mục)').onclick();
  assert.equal(sidebarFolder(get, 'competitor', -1).children[0].children[0].textContent, 'Không nhóm · 1');
  assert.equal(get('trash-count').textContent, '0');
});

test('trash lists dates and types, restores individually and confirms multi-item permanent deletion', async () => {
  const items = [
    { watchId: 'old1', label: 'Mục A', kind: 'project' },
    { watchId: 'old2', label: 'Mục B', kind: 'competitor' },
    { watchId: 'old3', label: 'Mục C', kind: 'project' },
  ].map((item) => ({ ...item, groupId: null, deletedAt: '2026-11-21T18:00:00Z', purgeAt: '2027-01-20T18:00:00Z' }));
  const { get, requests } = await boot(managedProfile({ items }));
  assert.equal(get('trash-count').textContent, '3');
  await get('trash-open').onclick();
  assert.equal(get('trash-dialog').open, true);
  let [first, second, third] = trashItems(get);
  assert.match(first.children[2].textContent, /Dự án · Đã xoá 22\/11\/2026 · Tự xoá sau 60 ngày/);
  action(first, 'Xoá hẳn').onclick();
  action(first.children.at(-1), 'Huỷ').onclick();
  assert.equal(requestCount(requests, 'POST'), 0);
  await action(first, 'Khôi phục').onclick();
  assert.ok(requests.findLast(({ method }) => method === 'POST').url.pathname.endsWith('/trash/restore'));
  assert.equal(get('trash-count').textContent, '2');
  [second, third] = trashItems(get);
  for (const item of [second, third]) check(item.children[0]);
  const bulk = trashActions(get);
  assert.equal(bulk.children[0].textContent, 'Đã chọn 2');
  action(bulk, 'Xoá hẳn').onclick();
  assert.equal(requestCount(requests, 'POST'), 1);
  await action(bulk.children.at(-1), 'Xoá hẳn').onclick();
  assert.deepEqual(requests.findLast(({ method }) => method === 'POST').body, { ids: ['old2', 'old3'] });
  assert.equal(get('trash-count').textContent, '0');
  assert.equal(get('trash-content').children[0].textContent, 'Thùng rác trống.');
  get('trash-close').onclick();
  assert.equal(get('trash-dialog').open, false);
});

test('ad details follow a domain or advertiser with same-kind folders and update after restoring by adding', async () => {
  const { get, requests } = await boot(managedProfile({
    folders: [{ id: 'projects', name: 'Nhóm dự án', kind: 'project' }, { id: 'rivals', name: 'Nhóm đối thủ', kind: 'competitor' }],
    items: [{ watchId: 'saved', value: 'example.com', label: 'Tên cũ', kind: 'project', groupId: null }],
  }));
  assert.match(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), />Chi tiết quảng cáo</);
  await sidebarRow(get, 'competitor').children[0].onclick();
  await get('mode-grid').onclick();
  get('ads').children[0].onclick();
  const follow = () => get('detail').children.at(-1);
  action(follow(), '+ Theo dõi dự án example.com').onclick();
  let chooser = follow().children[1];
  assert.deepEqual(chooser.children.slice(1).map((node) => node.textContent), ['Nhóm dự án', 'Không nhóm', 'Huỷ']);
  assert.equal(requestCount(requests, 'POST'), 0);
  await action(chooser, 'Nhóm dự án').onclick();
  assert.deepEqual(requests.findLast(({ method }) => method === 'POST').body,
    { input: 'example.com', kind: 'project', groupId: 'projects', region: null });
  assert.equal(get('trash-count').textContent, '0');
  assert.equal(action(follow(), 'Đang theo dõi').disabled, true);
  action(follow(), '+ Theo dõi nhà QC Example').onclick();
  chooser = follow().children.at(-1);
  assert.deepEqual(chooser.children.slice(1).map((node) => node.textContent), ['Nhóm đối thủ', 'Không nhóm', 'Huỷ']);
  await action(chooser, 'Không nhóm').onclick();
  assert.deepEqual(requests.findLast(({ method }) => method === 'POST').body,
    { input: 'AR1', kind: 'competitor', groupId: null, region: null });
  assert.equal(follow().children.filter((node) => node.textContent === 'Đang theo dõi').length, 2);
});

test('chart redraws at the measured pixel width without scaling text or increasing the date label limit', async () => {
  const observers = [];
  const browser = { ResizeObserver: class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
  } };
  const series = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.parse(refDate) - (29 - index) * 86_400_000).toISOString().slice(0, 10),
    running: index, newAds: 1,
  }));
  const { get } = await boot({ ...managedProfile({ series }), browser });
  await sidebarRow(get, 'competitor').children[0].onclick();
  const plot = get('watch-chart').children[1];
  const initial = plot.firstElementChild;
  assert.equal(initial.getAttribute('width'), '350');
  const observer = observers.find(({ target }) => target === plot);
  observer.callback([{ target: plot, contentRect: { width: 2560 } }]);
  const wide = plot.firstElementChild;
  assert.notEqual(wide, initial);
  assert.equal(wide.getAttribute('width'), '2560');
  assert.equal(wide.getAttribute('height'), '270');
  assert.equal(wide.getAttribute('viewBox'), null);
  assert.equal(wide.children.filter((node) => /^\d{2}\/\d{2}$/.test(node.textContent)).length, 8);
  const labels = wide.children.filter((node) => node.getAttribute('class') === 'chart-label');
  assert.deepEqual(labels.map((node) => [node.textContent, node.getAttribute('y')]),
    [['Ads đang chạy', '18'], ['Ads mới', '196']]);
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.series-chart text \{[^}]*font-size: 12px/);
  assert.match(css, /\.series-chart \.chart-label \{[^}]*font-size: 13px; font-weight: 600/);
});

test('a server without trash support keeps the watchlist visible and disables deletion controls', async () => {
  const { get } = await boot({ reply: ({ url }) => {
    if (/\/(groups|trash)$/.test(url.pathname)) return {
      status: 404, ok: false, json: async () => ({ error: 'Không tìm thấy.' }),
    };
  } });
  assert.equal(get('trash-open').disabled, true);
  assert.equal(get('select-competitor').disabled, true);
  assert.equal(action(sidebarRow(get, 'competitor'), '×'), undefined);
  await sidebarRow(get, 'competitor').children[0].onclick();
  assert.equal(get('gallery-heading').textContent, 'Đối thủ A');
});

test('ad detail follows directly when the matching kind has no folders', async () => {
  const { get, requests } = await boot(managedProfile({
    folders: [{ id: 'rivals', name: 'Nhóm đối thủ', kind: 'competitor' }],
  }));
  await sidebarRow(get, 'competitor').children[0].onclick();
  await get('mode-grid').onclick();
  get('ads').children[0].onclick();
  await action(get('detail').children.at(-1), '+ Theo dõi dự án example.com').onclick();
  assert.deepEqual(requests.findLast(({ method }) => method === 'POST').body,
    { input: 'example.com', kind: 'project', groupId: null, region: null });
});
