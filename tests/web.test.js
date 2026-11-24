import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const sidebarRow = (get, kind) =>
  get('watches-' + kind).children.at(-1).children[0].children[1].children[0].children[0];

const script = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

class Element {
  children = [];
  attributes = new Map();
  textContent = '';
  style = {};
  offsetTop = 0;

  showModal() { this.open = true; }
  close() { this.open = false; }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, right: 700, top: 0, bottom: 290, width: 700 }; }

  constructor(tag) { this.tag = tag; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  querySelectorAll() { return []; }
  replaceWith(node) { this.replacement = node; }
  get firstElementChild() { return this.children[0]; }
  get classList() {
    return {
      add: (name) => { this.className += ' ' + name; },
      toggle: (name, active) => { this.className = active ? name : ''; },
    };
  }
  clientWidth = 240;
  focus() { this.focused = true; }
  querySelector(selector) {
    assert.equal(selector, '.ad[aria-pressed="true"]');
    for (const child of this.children) {
      if (child.className === 'ad' && child.attributes.get('aria-pressed') === 'true') return child;
      const selected = child.querySelector(selector);
      if (selected) return selected;
    }
  }
  scrollIntoView() { this.scrolled = true; }
}

const scanAt = '2026-11-22T02:00:00Z';
const creative = {
  creativeId: 'CR1', platform: 'search', watchId: 'example-com', watchLabel: 'example.com',
  watchKind: 'competitor', domain: 'example.com', advertiserName: 'Example', advertiserId: 'AR1',
  format: 'image', firstShown: '2026-11-08T00:00:00Z', lastShown: '2026-11-10T00:00:00Z',
  firstSeenByUs: '2026-11-22T00:00:00Z',
  detailsUrl: 'https://adstransparency.google.com/advertiser/AR1/creative/CR1',
  regions: [
    { regionId: 2840, iso: 'US', lastShown: '2026-11-10T00:00:00Z' },
    { regionId: 2704, iso: 'VN', lastShown: '2026-11-08T00:00:00Z' },
  ],
};

const refDate = '2026-11-21';
const dataNote = 'Ngày tham chiếu đổi lúc 20:00 theo giờ Việt Nam.';
const spark = [{ date: refDate, running: 3 }];
const groupKey = 'example.com';
const group = {
  key: groupKey, name: 'example.com', groupType: 'domain', status: 'new',
  runningNow: 3, runningPrev: 0, delta: 3, newAds: 3, totalAds: 3, firstShown: refDate, followed: true,
  regions: ['US', 'VN', 'JP', 'DE', 'GB', 'FR', 'AU'].map((iso, index) => ({
    regionId: [2840, 2704, 2392, 2276, 2826, 2250, 2036][index], iso, running: index === 0 ? 3 : 1,
  })),
};
const projectGroup = {
  ...group, key: 'AR1', followed: false, name: 'Example', groupType: 'advertiser', status: 'increase',
  runningNow: 2, runningPrev: 1, delta: 1, regions: [], sampleAds: [],
};

async function loadGrid(results, groupResponse, storage = new Map(), { rangeResponse, ...browser } = {}) {
  const posts = [];
  const requests = [];
  const calls = [];
  let timer;
  const nodes = new Map();
  const documentEvents = new Map();
  const document = {
    addEventListener: (name, callback) => documentEvents.set(name, callback),
    body: new Element('body'),
    createElement(tag) {
      const node = new Element(tag);
      if (tag === 'iframe') node.contentWindow = {};
      return node;
    },
    createElementNS: (_, tag) => new Element(tag),
    querySelectorAll: () => [],
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new Element(id));
      return nodes.get(id);
    },
  };
  document.getElementById('profile').value = 'dai';
  document.getElementById('detail').parentElement = new Element('section');
  const clipboard = [];
  const form = document.getElementById('watch-form');
  form.elements = { input: new Element('input') };
  document.getElementById('gallery').children = ['ads', 'overview-watches'].map(document.getElementById);
  await runInNewContext(script, {
    document, URL, URLSearchParams,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    setTimeout: (callback, delay) => {
      if (delay === 250) timer = callback;
    },
    clearTimeout: () => {},
    navigator: { clipboard: { writeText: async (value) => clipboard.push(value) } },
    Option: class {},
    fetch: async (path, options) => {
      const url = new URL(path, 'http://localhost');
      const { pathname, searchParams } = url;
      calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      if (pathname === '/api/scan') return { ok: true, status: 202 };
      const json = async () => {
        if (path === '/api/status') return { scanning: false, scanningWatchId: null, last: null };
        if (pathname === '/api/suggest') return [
          { type: 'domain', value: 'example.com', ads: 3 },
          { type: 'advertiser', value: 'AR1', name: 'Example', ads: 1 },
        ];
        if (pathname.endsWith('/series')) return {
          refDate, minDate: '2026-10-22', from: searchParams.get('from') || '2026-10-22',
          to: searchParams.get('to') || refDate, bucket: 'day',
          points: [
            { date: '2026-11-09', running: 3, newAds: 2 },
            { date: '2026-11-10', running: 5, newAds: 1 },
            { date: refDate, running: 3, newAds: 1 },
          ].filter(({ date }) => date >= (searchParams.get('from') ?? '') && date <= (searchParams.get('to') ?? refDate)),
        };
        if (pathname.endsWith('/groups') || pathname.endsWith('/trash')) return [];
        if (path === '/api/profiles') return [{ id: 'dai', name: 'Dai' }];
        if (path.endsWith('/watchlist')) {
          if (options.method === 'POST') posts.push(JSON.parse(options.body));
          return [
            { id: 'example-com', label: 'example.com', value: 'example.com', type: 'domain' },
            { id: 'project', label: 'Dự án A', kind: 'project' },
          ];
        }
        if (pathname.endsWith('/summary')) {
          return {
            refDate, minDate: '2026-10-01', prevFrom: '2026-11-20', prevTo: '2026-11-20', dataNote,
            from: searchParams.get('from') || refDate, to: searchParams.get('to') || refDate,
            lastScan: { at: scanAt, status: 'ok' },
            totals: { newProjects: 1, newAdvertisers: 0, newAds: 4, increased: 3, decreased: 8, stopped: 13, runningAds: 7,
              runningAdsPrev: 42, increasedAds: 12, decreasedAds: -22, stoppedAds: -13,
              byType: { increased: { advertiser: 2, domain: 1 }, decreased: { advertiser: 8, domain: 0 },
                stopped: { advertiser: 13, domain: 0 } } },
            watches: [
              { watchId: 'example-com', label: 'example.com', kind: 'competitor', groupType: 'domain', runningNow: 5, runningPrev: 7, delta: -2, newAds: 3, spark,
                groups: [
                  { ...group, sampleAds: results.slice(0, 4) },
                  { ...group, key: 'fewer.example', name: 'fewer.example', status: 'decrease',
                    runningNow: 1, runningPrev: 3, delta: -2, regions: [], sampleAds: [] },
                  { ...group, key: 'stopped.example', name: 'stopped.example', status: 'stopped',
                    runningNow: 0, runningPrev: 3, delta: -3, regions: [], sampleAds: [] },
                  { ...group, key: 'steady.example', name: 'steady.example', status: 'steady',
                    runningNow: 1, runningPrev: 1, delta: 0, regions: [], sampleAds: [] },
                ] },
              { watchId: 'project', label: 'Dự án A', kind: 'project', groupType: 'advertiser', runningNow: 2, runningPrev: 1, delta: 1, newAds: 1, spark,
                groups: [projectGroup] },
            ],
          };
        }
        assert.equal(pathname, '/api/profiles/dai/ads');
        const params = url.searchParams;
        requests.push(params);
        if (params.has('group') && groupResponse) return groupResponse(params);
        if (rangeResponse) return rangeResponse(params);
        return results.filter((ad) => ad.watchId === params.get('watchId'));
      };
      return { ok: true, json };
    },
    ...browser,
  });
  assert.equal(nodes.get('error').hidden, true);
  const rows = () => nodes.get('overview-watches').children[0].children[1].children.filter((row) => !row.className?.startsWith('overview-folder '));
  const expand = (index = 0) => {
    rows()[index * 2].children[0].children[0].onclick();
    return rows()[index * 2 + 1].children[0].children;
  };
  const open = async () => {
    const [controls, panel] = expand()[0].children;
    await controls.children[0].onclick();
    return panel.children[1].children;
  };
  return { open, rows, expand, detail: nodes.get('detail'), nodes, clipboard, posts, requests, calls,
    documentEvents, suggest: () => timer() };
}

test('grid prefers a local image, then a remote image, then the placeholder', async () => {
  const imageUrl = 'https://example.com/remote.png';
  const { open } = await loadGrid([
    { ...creative, image: 'images/CR1.png', imageUrl },
    { ...creative, creativeId: 'CR2', imageUrl },
    { ...creative, creativeId: 'CR3' },
  ]);
  const cards = await open();
  const local = cards[0].children[0];
  assert.equal(local.src, '/images/CR1.png');
  local.onerror();
  assert.equal(local.src, imageUrl);
  local.onerror();
  assert.equal(local.replacement.children[1].textContent, 'Chưa có ảnh xem trước');
  assert.equal(cards[1].children[0].src, imageUrl);
  assert.equal(cards[2].children[0].children[1].textContent, 'Chưa có ảnh xem trước');
});

const liveUrl = 'https://displayads-formats.googleusercontent.com/ads/preview/content.js?sig=a%20b&x=1&x=2';
const origin = 'http://localhost:4317';

function mockLivePreviews() {
  const observed = new Set();
  const timers = new Map();
  let onVisibility;
  let onMessage;
  let onMutation;
  const browser = {
    IntersectionObserver: class {
      constructor(callback) { onVisibility = callback; }
      observe(node) { observed.add(node); }
      unobserve(node) { observed.delete(node); }
    },
    MutationObserver: class {
      constructor(callback) { onMutation = callback; }
      observe() {}
    },
    window: { location: { origin }, addEventListener: (_, callback) => { onMessage = callback; } },
    setTimeout(callback, delay) {
      const id = Symbol();
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  return {
    browser, observed, timers,
    visibility(nodes, isIntersecting) {
      onVisibility(nodes.filter((node) => observed.has(node)).map((target) => ({ target, isIntersecting })));
    },
    ready(source, width, height) {
      onMessage({ source, origin, data: { type: 'atc-preview-ready', width, height } });
    },
    mutation: () => onMutation(),
  };
}

test('cards and detail prefer images before live preview, with only images or format icons in group thumbnails', async () => {
  const live = mockLivePreviews();
  const imageUrl = 'https://example.com/remote.png';
  const input = { ...creative, format: 'video', previewUrl: liveUrl };
  const { open, expand, detail } = await loadGrid([
    { ...input, image: 'images/CR1.png', imageUrl },
    { ...input, creativeId: 'CR2', imageUrl },
    { ...input, creativeId: 'CR3' },
    { ...input, creativeId: 'CR4', previewUrl: 'https://example.com/content.js' },
  ], undefined, undefined, live.browser);
  const [controls] = expand()[0].children;
  const thumbs = controls.children[0].children[3].children;
  assert.deepEqual(thumbs.map((node) => node.children[0]?.src || node.textContent),
    ['/images/CR1.png', imageUrl, '▷', '▷']);
  assert.equal(live.observed.size, 0);

  expand();
  const cards = await open();
  const [localFrame] = cards[0].children;
  const [local, play] = localFrame.children;
  assert.equal(play.textContent, '▶');
  assert.equal(local.src, '/images/CR1.png');
  assert.equal(cards[1].children[0].children[0].src, imageUrl);
  assert.equal(cards[3].children[0].children[1].textContent, 'Chưa có ảnh xem trước');
  assert.equal(live.observed.size, 1);
  local.onerror();
  assert.equal(local.src, imageUrl);
  local.onerror();
  assert.ok(live.observed.has(localFrame.replacement));

  cards[0].onclick();
  const [detailFrame] = detail.children;
  const [detailImage] = detailFrame.children;
  assert.equal(detailImage.src, '/images/CR1.png');
  detailImage.onerror();
  assert.equal(detailImage.src, imageUrl);
  detailImage.onerror();
  const box = detailFrame.replacement;
  box.isConnected = true;
  live.visibility([box], true);
  const frame = box.children[1];
  box.children[0].remove = () => box.children.shift();
  live.ready(frame.contentWindow, 120, 160);
  assert.equal(frame.style.transform, 'scale(1)');
  assert.equal(box.style.height, '160px');

  const timedOut = localFrame.replacement;
  timedOut.isConnected = true;
  live.visibility([timedOut], true);
  const pending = [...live.timers.values()].filter(({ delay }) => delay === 12_000);
  assert.equal(pending.length, 1);
  pending[0].callback();
  const retry = timedOut.replacement;
  assert.equal(retry.children[0].tag, 'img');
  assert.equal(retry.children[0].src, imageUrl);
  retry.children[0].onerror();
  assert.equal(retry.replacement.children[1].textContent, 'Chưa có ảnh xem trước');
  assert.ok([...live.timers.values()].every(({ delay }) => delay !== 12_000));
});

test('live previews preserve URL parameters and load at most four visible frames, with a 12-second fallback', async () => {
  const live = mockLivePreviews();
  const { open } = await loadGrid(Array.from({ length: 6 }, (_, index) => ({
    ...creative, creativeId: 'CR' + index, previewUrl: liveUrl,
  })), undefined, undefined, live.browser);
  const boxes = (await open()).map((card) => card.children[0]);
  for (const box of boxes) {
    box.isConnected = true;
    box.children[0].remove = () => box.children.shift();
  }
  const frames = () => boxes.map((box) => box.children.find((node) => node.tag === 'iframe'));
  assert.equal(frames().filter(Boolean).length, 0);
  live.visibility(boxes, true);
  assert.equal(frames().filter(Boolean).length, 4);
  const [first, second] = frames();
  assert.equal(first.attributes.get('sandbox'), 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  assert.match(first.srcdoc, /<head>[^]*?<base href="https:\/\/displayads-formats\.googleusercontent\.com\/">[^]*?<\/head>/);
  const src = first.srcdoc.match(/<script src="([^"]+)"/)[1].replaceAll('&amp;', '&');
  const url = new URL(src);
  assert.ok(src.startsWith(liveUrl + '&'));
  assert.equal(url.searchParams.get('htmlParentId'), 'atc-preview');
  assert.equal(url.searchParams.get('responseCallback'), 'atcPreviewReady');

  live.visibility([boxes[4]], false);
  live.ready({}, 240, 360);
  assert.equal(frames()[5], undefined);
  let addedContent;
  let contentChanged;
  const childWindow = { origin };
  runInNewContext(first.srcdoc.match(/<script>([\s\S]+?)<\/script>/)[1], {
    window: childWindow,
    document: { getElementById: () => ({ querySelector: () => addedContent, textContent: '' }) },
    MutationObserver: class {
      constructor(callback) { contentChanged = callback; }
      observe() {}
      disconnect() {}
    },
    parent: { postMessage(message, targetOrigin) {
      assert.equal(targetOrigin, '*'); // khung cách ly có nguồn "null"
      assert.equal(message.type, 'atc-preview-ready');
      live.ready(first.contentWindow, message.width, message.height);
    } },
  });
  childWindow.atcPreviewReady({ previewMetadata: [{ width: 240, height: 360 }] });
  assert.equal(first.style.transform, undefined);
  addedContent = {};
  contentChanged();
  assert.equal(first.style.transform, 'scale(0.5)');
  assert.equal(first.style.width, '240px');
  assert.equal(first.style.height, '360px');
  assert.equal(frames()[4], undefined);
  assert.ok(frames()[5]);
  live.visibility([boxes[0]], false);
  live.visibility([boxes[0], boxes[4]], true);
  assert.equal(frames()[0], first);

  const pending = [...live.timers.values()].filter(({ delay }) => delay === 12_000);
  assert.equal(pending.length, 4);
  pending[0].callback();
  assert.equal(boxes[1].replacement.children[1].textContent, 'Chưa có ảnh xem trước');
  assert.ok(frames()[4]);
  live.ready(second.contentWindow, 240, 360);
  assert.equal(second.style.transform, undefined);

  boxes[2].isConnected = false;
  live.mutation();
  assert.equal([...live.timers.values()].filter(({ delay }) => delay === 12_000).length, 3);
});

test('cards show advertiser, website, Vietnamese dates and applicable badges', async () => {
  const { open, detail } = await loadGrid([
    { ...creative, domainSource: 'ocr', isNew: true, isRunning: false },
    { ...creative, creativeId: 'CR2', domain: null, format: 'video', firstShown: '2026-11-20', lastShown: scanAt },
  ]);
  const cards = await open();
  const [name, domain, dates, badges, flags] = cards[0].children[1].children;
  assert.deepEqual([name.textContent, domain.textContent, dates.textContent], [
    'Example', 'example.com', 'Bắt đầu 08/11/2026 · Gần nhất 10/11/2026',
  ]);
  assert.deepEqual(badges.children.map((node) => node.textContent), ['Mới', 'Đã dừng']);
  assert.deepEqual(badges.children.map((node) => node.className), ['badge tone-new', 'badge tone-stopped']);
  assert.deepEqual(flags.children.map((node) => node.textContent), ['🇺🇸', '🇻🇳']);
  assert.equal(cards[1].children[1].children[3].children.length, 0);
  assert.equal(domain.children.length, 0);
  cards[0].onclick();
  const [note] = detail.children[1].children[3].children;
  assert.equal(note.tag, 'small');
  assert.equal(note.textContent.trim(), '(đọc từ ảnh)');
  cards[1].onclick();
  for (const label of [cards[1].children[1].children[1], detail.children[1].children[3]]) {
    assert.equal(label.textContent, 'Chưa rõ tên miền');
    assert.equal(label.className, 'domain-unknown');
  }
});

test('search suggests both types and sidebar buttons filter suggestions only', async () => {
  const { nodes, posts, suggest, calls } = await loadGrid([]);
  const form = nodes.get('watch-form');
  const input = form.elements.input;
  const hint = nodes.get('watch-type-hint');
  const list = nodes.get('suggestions');
  const titles = () => list.children.map((section) => section.children[0].textContent);
  const type = (value) => {
    input.value = value;
    input.oninput();
  };

  type('Example');
  assert.equal(hint.hidden, true);
  await suggest();
  assert.equal(calls.at(-1).url.searchParams.get('q'), 'Example');
  assert.deepEqual(titles(), ['Nhà quảng cáo', 'Dự án (tên miền)']);
  assert.deepEqual(list.children.map((section) => [
    section.className, section.children[1].children[1].textContent,
  ]), [['kind-competitor', 'Nhà quảng cáo'], ['kind-project', 'Dự án']]);

  nodes.get('add-project').onclick();
  assert.equal(input.focused, true);
  await suggest();
  assert.deepEqual(titles(), ['Dự án (tên miền)']);
  type('ar1');
  assert.equal(hint.textContent, 'Sẽ thêm vào Nhà quảng cáo: AR1');
  await form.onsubmit({ preventDefault() {} });

  nodes.get('add-competitor').onclick();
  type('https://WWW.Example.com/path');
  assert.equal(hint.textContent, 'Sẽ thêm vào Dự án: example.com');
  await suggest();
  assert.deepEqual(titles(), ['Nhà quảng cáo']);
  await form.onsubmit({ preventDefault() {} });
  assert.deepEqual(posts, [
    { input: 'ar1', region: null },
    { input: 'https://WWW.Example.com/path', region: null },
  ]);
  assert.equal(hint.hidden, true);
});

test('clicking a card opens and updates the right-hand detail panel', async () => {
  const imageUrl = 'https://example.com/detail.png';
  const { open, detail, clipboard } = await loadGrid([
    { ...creative, imageUrl },
    { ...creative, creativeId: 'CR2', domain: 'other.com' },
  ]);
  assert.match(detail.textContent, /Chọn một mẫu/);
  const cards = await open();
  cards[0].onclick();
  const [image, fields, regionHeading, countries, actions] = detail.children;
  const [link, copy] = actions.children;
  assert.equal(image.src, imageUrl);
  assert.deepEqual(fields.children.map((node) => node.textContent), [
    'Nhà quảng cáo', 'Example', 'Website', 'example.com', 'Định dạng', 'Hình ảnh',
    'Bắt đầu chạy', '08/11/2026', 'Lần chạy gần nhất', '10/11/2026',
    'Số ngày chạy', '3', 'Trạng thái', '',
  ]);
  assert.equal(fields.children.at(-1).children[0].textContent, 'Đã dừng');
  assert.equal(regionHeading.textContent, 'Quốc gia hiển thị (2)');
  assert.deepEqual(countries.children.map((row) => row.children.map((node) => node.textContent)), [
    ['🇺🇸 Hoa Kỳ', '', 'chưa rõ → 10/11/2026', 'Đã dừng'],
    ['🇻🇳 Việt Nam', '', 'chưa rõ → 08/11/2026', 'Đã dừng'],
  ]);
  assert.equal(copy.textContent, 'Sao chép link');
  assert.equal(link.href, creative.detailsUrl);
  assert.equal(link.target, '_blank');
  await copy.onclick();
  assert.deepEqual(clipboard, [creative.detailsUrl]);
  assert.equal(copy.textContent, 'Đã sao chép');
  assert.equal(detail.parentElement.scrolled, true);
  cards[1].onclick();
  assert.equal(cards[0].attributes.get('aria-pressed'), 'false');
  assert.equal(cards[1].attributes.get('aria-pressed'), 'true');
  assert.equal(detail.children[1].children[3].textContent, 'other.com');
});

test('overview shows grouped changes, stable watch colors and the two totals blocks', async () => {
  const { rows, expand, nodes, requests, calls } = await loadGrid([
    { ...creative, image: 'images/CR1.png' },
    { ...creative, creativeId: 'CR2', imageUrl: 'https://example.com/remote.png' },
  ]);
  assert.equal(requests.length, 0);
  assert.equal(nodes.get('gallery-summary').textContent, dataNote);
  assert.equal(calls.find(({ url }) => url.pathname.endsWith('/summary')).url.searchParams.get('from'), null);
  assert.equal(nodes.get('range-value').textContent, 'Hôm nay');
  assert.equal(nodes.get('comparison').textContent, 'So với 20/11 – 20/11');
  const [competitor, , project] = rows();
  const [running, delta] = competitor.children[2].children[0].children;
  assert.equal(running.textContent, '5');
  assert.equal(delta.textContent, '▼ −2');
  assert.equal(delta.className, 'delta-down');
  assert.equal(competitor.children[4].children[0].attributes.get('role'), 'img');
  assert.equal(project.children[1].children[0].textContent, 'Dự án');
  const sidebar = sidebarRow((id) => nodes.get(id), 'competitor').children[0];
  const dotStyle = (name) => name.children[0].attributes.get('style');
  assert.match(dotStyle(sidebar.children[0]), /^--watch-color: #[a-f0-9]{6}$/);
  assert.equal(dotStyle(sidebar.children[0]), dotStyle(competitor.children[0].children[0].children[1]));
  const first = expand()[0].children[0];
  const [name, counts, flags, thumbs] = first.children[0].children;
  assert.equal(first.children.length, 2);
  assert.equal(first.children[1].textContent, 'Lấy quốc gia cả dự án');
  assert.equal(name.children[0].textContent, 'Dự án mới');
  assert.deepEqual(name.children[1].children.map((node) => node.textContent), ['example.com', '↗']);
  assert.deepEqual(counts.children.map((node) => node.textContent), ['0 → 3', '+3', '3 ads mới']);
  assert.deepEqual(flags.children.map((node) => node.textContent), ['🇺🇸 3', '🇻🇳 1', '🇯🇵 1', '🇩🇪 1', '🇬🇧 1', '🇫🇷 1', '+1']);
  assert.deepEqual(thumbs.children.map((node) => node.src), ['/images/CR1.png', 'https://example.com/remote.png']);
  assert.equal(expand(1)[0].children[0].children[1].textContent, 'Theo dõi');
  const blocks = nodes.get('totals').children;
  assert.deepEqual(blocks.map((block) => block.children[0].textContent), ['Quảng cáo', 'Đối thủ thay đổi']);
  const [runningTotal, newAds, newGroups, increased, decreased, stopped] = blocks.flatMap((block) => block.children[1].children);
  const values = (button) => button.children.slice(1).map((node) => node.textContent);
  assert.deepEqual(values(runningTotal), ['7', 'ads', '−35 so với 20/11']);
  assert.equal(runningTotal.children[3].className, 'overview-total-note delta-down');
  assert.deepEqual(values(newAds), ['4', 'ads']);
  assert.deepEqual(values(newGroups), ['1', '1 dự án · 0 nhà QC']);
  assert.deepEqual(values(increased), ['3', '2 nhà QC · 1 dự án', '+12 ads']);
  assert.deepEqual(values(decreased), ['8', 'nhà quảng cáo', '−22 ads']);
  assert.deepEqual(values(stopped), ['13', 'nhà quảng cáo', '−13 ads']);
  const visibleStatuses = () => rows().filter((_, index) => index % 2).flatMap((row) =>
    row.children[0].children.map((group) => group.children[0].children[0].children[0].children[0].textContent));
  for (const [button, status] of [[newGroups, 'Dự án mới'], [increased, 'Chạy thêm ads'],
    [decreased, 'Chạy bớt ads'], [stopped, 'Tắt hết ads']]) {
    assert.ok(button.title);
    button.onclick();
    assert.equal(button.attributes.get('aria-pressed'), 'true');
    assert.deepEqual(visibleStatuses(), [status]);
  }
  runningTotal.onclick();
  assert.equal(stopped.attributes.get('aria-pressed'), 'false');
  assert.deepEqual(visibleStatuses(), ['Dự án mới', 'Chạy bớt ads', 'Tắt hết ads', 'Ổn định', 'Chạy thêm ads']);
});

test('group opens inline and loads only the selected watch and group', async () => {
  const { expand, nodes, requests, calls } = await loadGrid([creative,
    { ...creative, creativeId: 'CR2', platform: 'display' },
  ]);
  const [controls, panel] = expand()[0].children;
  const [row] = controls.children;
  await row.onclick();
  assert.equal(row.attributes.get('aria-expanded'), 'true');
  assert.equal(panel.hidden, false);
  assert.equal(panel.children[1].children.length, 1);
  assert.equal(requests[0].get('watchId'), 'example-com');
  assert.equal(requests[0].get('group'), groupKey);
  const series = calls.find(({ url }) => url.pathname.endsWith('/series')).url.searchParams;
  assert.equal(series.get('watchId'), 'example-com');
  assert.equal(series.get('group'), groupKey);
  assert.equal(series.get('from'), refDate);
  assert.equal(series.get('to'), refDate);
  assert.equal(requests[0].get('from'), refDate);
  row.onclick();
  assert.equal(row.attributes.get('aria-expanded'), 'false');
  assert.equal(panel.hidden, true);
  const [projectControls, projectPanel] = expand(1)[0].children;
  await projectControls.children[0].onclick();
  assert.equal(requests[1].get('watchId'), 'project');
  assert.equal(requests[1].get('group'), projectGroup.key);
  assert.equal(projectPanel.children[1].textContent, 'Chưa có mẫu phù hợp.');
  await sidebarRow((id) => nodes.get(id), 'competitor').children[0].onclick();
  assert.equal(nodes.get('overview').hidden, true);
  assert.equal(nodes.get('home').attributes.get('aria-pressed'), 'false');
  await nodes.get('mode-grid').onclick();
  assert.equal(nodes.get('ads').children.length, 1);
  await nodes.get('home').onclick();
  assert.equal(nodes.get('overview').hidden, false);
  assert.equal(nodes.get('watch-view').hidden, true);
  assert.equal(nodes.get('home').attributes.get('aria-pressed'), 'true');
  await sidebarRow((id) => nodes.get(id), 'competitor').children[1].onclick();
  assert.deepEqual(calls.find(({ url }) => url.pathname === '/api/scan').body, { watchId: 'example-com' });
});

test('an ads response arriving after the group is closed cannot reopen it', async () => {
  let finish;
  const delayed = new Promise((resolve) => { finish = resolve; });
  const { expand, nodes } = await loadGrid([creative], () => delayed);
  const [controls, panel] = expand()[0].children;
  const loading = controls.children[0].onclick();
  nodes.get('totals').children[1].children[1].children[1].onclick();
  finish([creative]);
  await loading;
  assert.equal(panel.hidden, true);
  assert.equal(panel.children.length, 0);
});


test('the calendar validates dates, applies a range to every view and persists it', async () => {
  const storage = new Map();
  const { nodes, calls, requests } = await loadGrid([creative], undefined, storage);
  await sidebarRow((id) => nodes.get(id), 'competitor').children[0].onclick();
  assert.equal(nodes.get('range-value').textContent, 'Mọi lúc');
  nodes.get('range-open').onclick();
  assert.equal(nodes.get('calendar-title').textContent, 'THG 10 2026');
  const [october, november] = nodes.get('calendar-months').children;
  const day = (month, label) => month.children[1].children.find((node) => node.textContent === label);
  assert.equal(day(october, '21').disabled, true);
  assert.equal(day(november, '22').disabled, true);
  nodes.get('calendar-next').onclick();
  assert.equal(nodes.get('calendar-title').textContent, 'THG 11 2026');
  nodes.get('calendar-prev').onclick();
  day(october, '22').onclick();
  day(november, '10').onclick();
  assert.match(day(october, '22').className, /range-start/);
  assert.match(day(november, '10').className, /range-end/);
  assert.match(day(november, '5').className, /in-range/);
  const submit = () => nodes.get('range-form').onsubmit({ preventDefault() {} });
  nodes.get('range-to').value = '31 thg 11, 2026';
  await submit();
  assert.equal(nodes.get('range-error').hidden, false);
  nodes.get('range-to').value = '10 thg 11, 2026';
  await submit();
  assert.equal(nodes.get('range-dialog').open, false);
  assert.equal(nodes.get('range-value').textContent, '22 thg 10 – 10 thg 11, 2026');
  nodes.get('range-open').onclick();
  assert.equal(nodes.get('calendar-title').textContent, 'THG 10 2026');
  nodes.get('range-cancel').onclick();
  await nodes.get('mode-grid').onclick();
  assert.equal(requests.at(-1).get('from'), '2026-10-22');
  assert.equal(requests.at(-1).get('to'), '2026-11-10');
  await nodes.get('home').onclick();
  for (const endpoint of ['summary', 'series', 'ads']) {
    const { url } = calls.findLast(({ url }) => url.pathname.endsWith('/' + endpoint));
    assert.equal(url.searchParams.get('from'), '2026-10-22');
    assert.equal(url.searchParams.get('to'), '2026-11-10');
  }
  const reloaded = await loadGrid([], undefined, storage);
  assert.equal(reloaded.nodes.get('range-value').textContent, '22 thg 10 – 10 thg 11, 2026');
});

test('the chart shares a tooltip, switches to a table and applies a dragged range', async () => {
  const { nodes, calls } = await loadGrid([creative]);
  await sidebarRow((id) => nodes.get(id), 'competitor').children[0].onclick();
  const [header, plot, table] = nodes.get('watch-chart').children;
  const [svg, tooltip] = plot.children;
  const hit = svg.children.at(-1);
  hit.onpointermove({ clientX: 365 });
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.textContent, '10/11/2026\nAds đang chạy: 5\nAds mới: 1');
  assert.ok(svg.children.some((node) => node.attributes.get('class') === 'chart-area'));
  assert.equal(svg.children.filter((node) => node.attributes.get('class') === 'chart-bar').length, 3);
  const toggle = header.children.at(-1);
  toggle.onclick();
  assert.equal(plot.hidden, true);
  assert.equal(table.hidden, false);
  assert.equal(table.children[1].children.length, 3);
  toggle.onclick();
  const mouse = { button: 0, pointerId: 1, pointerType: 'mouse' };
  hit.onpointerdown({ ...mouse, clientX: 130 });
  await hit.onpointerup({ ...mouse, clientX: 130 });
  assert.match(tooltip.textContent, /^09\/11\/2026/);
  assert.equal(tooltip.hidden, false);
  assert.equal(nodes.get('range-value').textContent, 'Mọi lúc');
  hit.onpointerdown({ ...mouse, clientX: 130 });
  hit.onpointermove({ ...mouse, clientX: 365 });
  await hit.onpointerup({ ...mouse, clientX: 365 });
  assert.equal(nodes.get('range-value').textContent, '9 thg 11 – 10 thg 11, 2026');
  assert.equal(calls.findLast(({ url }) => url.pathname.endsWith('/series')).url.searchParams.get('to'), '2026-11-10');
  await nodes.get('watch-chart').children[0].children[1].onclick();
  assert.equal(nodes.get('range-value').textContent, 'Mọi lúc');
});

test('touch and pen read the chart without applying a date range', async () => {
  const storage = new Map();
  const { nodes, calls, documentEvents } = await loadGrid([creative], undefined, storage);
  await sidebarRow((id) => nodes.get(id), 'competitor').children[0].onclick();
  const [, plot] = nodes.get('watch-chart').children;
  const [svg, tooltip] = plot.children;
  const hit = svg.children.at(-1);
  const requestCount = calls.length;
  for (const pointerType of ['touch', 'pen']) {
    const contact = { button: 0, pointerId: 2, pointerType };
    hit.onpointerdown({ ...contact, clientX: 130 });
    hit.onpointermove({ ...contact, clientX: 365 });
    assert.equal(tooltip.textContent, '10/11/2026\nAds đang chạy: 5\nAds mới: 1');
    await hit.onpointerup({ ...contact, clientX: 365 });
    hit.onlostpointercapture(contact);
    hit.onpointerleave(contact);
    assert.equal(tooltip.hidden, false);
    documentEvents.get('pointerdown')({ composedPath: () => [nodes.get('gallery')] });
    assert.equal(tooltip.hidden, true);
  }
  assert.equal(calls.length, requestCount);
  assert.equal(storage.has('atc-iso-date-range'), false);
  assert.equal(nodes.get('range-value').textContent, 'Mọi lúc');
});

test('the mobile drawer closes on selection and ad details restore focus on close', async () => {
  const { nodes } = await loadGrid([creative], undefined, new Map(), {
    matchMedia: () => ({ matches: true, addEventListener() {} }),
  });
  const menu = nodes.get('watch-menu');
  menu.onclick({ currentTarget: menu });
  assert.equal(menu.attributes.get('aria-expanded'), 'true');
  assert.equal(nodes.get('watch-menu-close').focused, true);
  assert.equal(nodes.get('gallery').inert, true);
  await sidebarRow((id) => nodes.get(id), 'competitor').children[0].onclick();
  assert.equal(menu.attributes.get('aria-expanded'), 'false');
  assert.equal(nodes.get('gallery').inert, false);

  await nodes.get('mode-grid').onclick();
  const [ad] = nodes.get('ads').children;
  ad.onclick();
  assert.equal(nodes.get('detail-panel').attributes.get('data-open'), 'true');
  assert.equal(nodes.get('detail-close').focused, true);
  nodes.get('detail-close').onclick();
  assert.equal(nodes.get('detail-panel').attributes.get('data-open'), 'false');
  assert.equal(ad.focused, true);
});

test('each watch shows date-filtered totals from the same ads as the grid', async () => {
  const other = { ...creative, creativeId: 'CR2', advertiserId: 'AR2', domain: 'other.com',
    firstShown: '2026-11-09T17:00:00Z', lastShown: '2026-11-10T17:00:00Z' };
  const unknown = { ...creative, creativeId: 'CR3', domain: null,
    firstShown: '2026-11-09T16:59:59Z', lastShown: '2026-11-09T16:59:59Z' };
  const fixtures = [creative, other, unknown];
  const localDay = (value) => new Date(Date.parse(value) + 7 * 3_600_000).toISOString().slice(0, 10);
  const { nodes } = await loadGrid(fixtures, undefined, new Map(), {
    rangeResponse: (params) => fixtures.filter(({ firstShown, lastShown }) => !params.has('from')
      || (localDay(firstShown) <= params.get('to') && localDay(lastShown) >= params.get('from'))),
  });
  const stats = () => nodes.get('watch-stats-cards').children.map((card) => card.children.slice(0, 2).map((node) => node.textContent));
  const deltas = () => nodes.get('watch-stats-cards').children.map((card) => card.children[2]?.textContent ?? null);
  const select = (kind) => sidebarRow((id) => nodes.get(id), kind).children[0].onclick();
  const setDate = async (day) => {
    nodes.get('range-open').onclick();
    nodes.get('range-from').value = nodes.get('range-to').value = day + ' thg 11, 2026';
    await nodes.get('range-form').onsubmit({ preventDefault() {} });
  };
  await select('competitor');
  const note = nodes.get('watch-stats-unknown');
  assert.deepEqual(stats(), [['Dự án', '2'], ['Ads', '3'], ['Ads mới', '3']]);
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, '+1 ads chưa rõ tên miền');
  await nodes.get('mode-grid').onclick();
  await setDate(10);
  assert.deepEqual(stats(), [['Dự án', '2'], ['Ads', '2'], ['Ads mới', '1']]);
  assert.ok(deltas().every((text) => /^[+−±]\d+ so với /.test(text)));
  assert.equal(note.hidden, true);
  assert.equal(nodes.get('ads').children.length, 2);

  await select('project');
  assert.deepEqual(stats(), [['Nhà quảng cáo', '2'], ['Ads', '2'], ['Ads mới', '1']]);
  await nodes.get('mode-grid').onclick();
  await setDate(9);
  assert.deepEqual(stats(), [['Nhà quảng cáo', '1'], ['Ads', '2'], ['Ads mới', '1']]);
  assert.equal(nodes.get('ads').children.length, 2);
  assert.equal(note.hidden, true);
});

test('reset to all time persists and the calendar still starts at the profile minimum', async () => {
  const storage = new Map();
  const { nodes } = await loadGrid([], undefined, storage);
  nodes.get('range-open').onclick();
  nodes.get('range-dialog').onclick({ target: nodes.get('range-dialog'), clientX: -1, clientY: 10 });
  assert.equal(nodes.get('range-dialog').open, false);
  nodes.get('range-open').onclick();
  nodes.get('range-presets').children.at(-1).onclick();
  await nodes.get('range-form').onsubmit({ preventDefault() {} });
  const reloaded = await loadGrid([], undefined, storage);
  assert.equal(reloaded.nodes.get('range-value').textContent, 'Mọi lúc');
  const request = reloaded.calls.findLast(({ url }) => url.pathname.endsWith('/summary'));
  assert.equal(request.url.searchParams.get('from'), null);
  assert.equal(request.url.searchParams.get('to'), null);
  reloaded.nodes.get('range-open').onclick();
  assert.equal(reloaded.nodes.get('range-from').value, '1 thg 10, 2026');
});
