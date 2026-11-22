import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

class Element {
  children = [];
  attributes = new Map();
  textContent = '';

  constructor(tag) { this.tag = tag; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  querySelectorAll() { return []; }
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

const groupKey = 'domain:example.com';
const group = {
  key: groupKey, name: 'example.com', groupType: 'domain', status: 'new',
  runningNow: 3, runningBefore: 0, delta: 3, newAds: 3, totalAds: 3, firstSeen: scanAt,
  regions: ['US', 'VN', 'JP', 'DE', 'GB', 'FR', 'AU'].map((iso, index) => ({
    regionId: [2840, 2704, 2392, 2276, 2826, 2250, 2036][index], iso, running: index === 0 ? 3 : 1,
  })),
};
const projectGroup = {
  ...group, key: 'advertiser:AR1', name: 'Example', groupType: 'advertiser', status: 'increase',
  runningNow: 2, runningBefore: 1, delta: 1, regions: [], sampleAds: [],
};

async function loadGrid(results, overview = {}, groupResponse) {
  const posts = [];
  const requests = [];
  const nodes = new Map();
  const document = {
    createElement: (tag) => new Element(tag),
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
    document, URLSearchParams, clearTimeout,
    navigator: { clipboard: { writeText: async (value) => clipboard.push(value) } },
    Option: class {},
    fetch: async (path, options) => ({
      ok: true,
      json: async () => {
        if (path === '/api/status') return { scanning: false };
        if (path === '/api/profiles') return [{ id: 'dai', name: 'Dai' }];
        if (path.endsWith('/watchlist')) {
          if (options.method === 'POST') posts.push(JSON.parse(options.body));
          return [
            { id: 'example-com', label: 'example.com', value: 'example.com', type: 'domain' },
            { id: 'project', label: 'Dự án A', kind: 'project' },
          ];
        }
        if (path.endsWith('/summary')) {
          return {
            lastScan: { at: scanAt, status: 'ok' }, previousScanAt: null,
            totals: { newGroups: 1, increased: 1, decreased: 1, stopped: 1, runningAds: 7 },
            watches: [
              { watchId: 'example-com', label: 'example.com', kind: 'competitor', runningNow: 5, runningBefore: 7,
                groups: [
                  { ...group, sampleAds: results.slice(0, 4) },
                  { ...group, key: 'domain:fewer.example', name: 'fewer.example', status: 'decrease',
                    runningNow: 1, runningBefore: 3, delta: -2, regions: [], sampleAds: [] },
                  { ...group, key: 'domain:stopped.example', name: 'stopped.example', status: 'stopped',
                    runningNow: 0, runningBefore: 3, delta: -3, regions: [], sampleAds: [] },
                  { ...group, key: 'domain:steady.example', name: 'steady.example', status: 'steady',
                    runningNow: 1, runningBefore: 1, delta: 0, regions: [], sampleAds: [] },
                ] },
              { watchId: 'project', label: 'Dự án A', kind: 'project', runningNow: 2, runningBefore: 1,
                groups: [projectGroup] },
            ],
            ...overview,
          };
        }
        const url = new URL(path, 'http://localhost');
        assert.equal(url.pathname, '/api/profiles/dai/ads');
        const params = url.searchParams;
        requests.push(params);
        if (params.has('group') && groupResponse) return groupResponse(params);
        return results.filter((ad) => ad.watchId === params.get('watchId'));
      },
    }),
  });
  assert.equal(nodes.get('error').hidden, true);
  const blocks = () => nodes.get('overview-watches').children;
  const open = async () => {
    const [row, panel] = blocks()[0].children[2].children;
    await row.onclick();
    return panel.children[0].children;
  };
  return { open, blocks, detail: nodes.get('detail'), nodes, clipboard, posts, requests };
}

test('grid prefers a local image, then a remote image, then the placeholder', async () => {
  const imageUrl = 'https://example.com/remote.png';
  const { open } = await loadGrid([
    { ...creative, image: 'images/CR1.png', imageUrl },
    { ...creative, creativeId: 'CR2', imageUrl },
    { ...creative, creativeId: 'CR3' },
  ]);
  const cards = await open();
  assert.equal(cards[0].children[0].src, '/images/CR1.png');
  assert.equal(cards[1].children[0].src, imageUrl);
  assert.equal(cards[2].children[0].children[1].textContent, 'Chưa có ảnh xem trước');
});

test('cards show advertiser, website, Vietnamese dates and applicable badges', async () => {
  const { open } = await loadGrid([
    creative,
    { ...creative, creativeId: 'CR2', domain: null, format: 'video', firstSeenByUs: '2026-11-10', lastShown: scanAt },
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
});

test('overview shows grouped changes, stable watch colors, and filters with all five totals', async () => {
  const { blocks, nodes, requests } = await loadGrid([
    { ...creative, image: 'images/CR1.png' },
    { ...creative, creativeId: 'CR2', imageUrl: 'https://example.com/remote.png' },
  ], { previousScanAt: '2026-11-21T19:05:00Z' });
  assert.equal(requests.length, 0);
  assert.equal(nodes.get('gallery-summary').textContent, 'So với lượt quét trước lúc 02:05 22/11');
  const [competitor, project] = blocks();
  const [heading, category, firstGroup] = competitor.children;
  assert.equal(heading.children[1].textContent, 'Đang chạy 5 mẫu (−2 so với lượt trước)');
  assert.equal(category.textContent, 'Dự án');
  assert.equal(project.children[1].textContent, 'Nhà quảng cáo');
  assert.equal(project.children[2].children[0].children[0].children[1].textContent, 'Example');
  const sidebar = nodes.get('watches-competitor').children[0].children[0];
  const dotStyle = (name) => name.children[0].attributes.get('style');
  assert.match(dotStyle(sidebar.children[0]), /^--watch-color: #[a-f0-9]{6}$/);
  assert.equal(dotStyle(sidebar.children[0]), dotStyle(heading.children[0]));
  const [name, counts, flags, thumbs] = firstGroup.children[0].children;
  assert.deepEqual(name.children.map((node) => node.textContent), ['Dự án mới', 'example.com']);
  assert.deepEqual(counts.children.map((node) => node.textContent), ['0 → 3', '+3', '3 mẫu mới']);
  assert.deepEqual(flags.children.map((node) => node.textContent), ['🇺🇸 3', '🇻🇳 1', '🇯🇵 1', '🇩🇪 1', '🇬🇧 1', '🇫🇷 1', '+1']);
  assert.deepEqual(thumbs.children.map((node) => node.src), ['/images/CR1.png', 'https://example.com/remote.png']);
  const totals = nodes.get('totals').children;
  assert.deepEqual(totals.map((card) => card.children.map((node) => node.textContent)), [
    ['Dự án mới', '1'], ['Chạy thêm ads', '1'], ['Giảm ads', '1'], ['Đã dừng', '1'], ['Mẫu đang chạy', '7'],
  ]);
  const visibleStatuses = () => blocks().flatMap((block) => block.children.slice(2)
    .map((row) => row.children[0].children[0].children[0].textContent));
  for (const card of totals.slice(0, 4)) {
    card.onclick();
    assert.equal(card.attributes.get('aria-pressed'), 'true');
    assert.deepEqual(visibleStatuses(), [card.children[0].textContent]);
  }
  totals[4].onclick();
  assert.deepEqual(visibleStatuses(), ['Dự án mới', 'Giảm ads', 'Ổn định', 'Chạy thêm ads']);
  totals[4].onclick();
  assert.deepEqual(visibleStatuses(), ['Dự án mới', 'Giảm ads', 'Đã dừng', 'Ổn định', 'Chạy thêm ads']);
});

test('group opens inline and loads only the selected watch and group', async () => {
  const { blocks, nodes, requests } = await loadGrid([creative,
    { ...creative, creativeId: 'CR2', platform: 'display' },
  ]);
  assert.equal(nodes.get('gallery-summary').textContent, 'Lượt quét đầu tiên — chưa có so sánh');
  const [row, panel] = blocks()[0].children[2].children;
  await row.onclick();
  assert.equal(row.attributes.get('aria-expanded'), 'true');
  assert.equal(panel.hidden, false);
  assert.equal(panel.children[0].children.length, 1);
  assert.equal(requests[0].get('watchId'), 'example-com');
  assert.equal(requests[0].get('group'), groupKey);
  row.onclick();
  assert.equal(row.attributes.get('aria-expanded'), 'false');
  assert.equal(panel.hidden, true);
  const [projectRow, projectPanel] = blocks()[1].children[2].children;
  await projectRow.onclick();
  assert.equal(requests[1].get('watchId'), 'project');
  assert.equal(requests[1].get('group'), projectGroup.key);
  assert.equal(projectPanel.children[0].textContent, 'Chưa có mẫu phù hợp.');
  await nodes.get('watches-competitor').children[0].children[0].onclick();
  assert.equal(nodes.get('overview').hidden, true);
  assert.equal(nodes.get('ads').children.length, 1);
  nodes.get('home').onclick();
  assert.equal(nodes.get('overview').hidden, false);
  assert.equal(nodes.get('watch-view').hidden, true);
});

test('an ads response arriving after the group is closed cannot reopen it', async () => {
  let finish;
  const delayed = new Promise((resolve) => { finish = resolve; });
  const { blocks, nodes } = await loadGrid([creative], {}, () => delayed);
  const [row, panel] = blocks()[0].children[2].children;
  const loading = row.onclick();
  nodes.get('totals').children[1].onclick();
  finish([creative]);
  await loading;
  assert.equal(panel.hidden, true);
  assert.equal(panel.children.length, 0);
});

test('the add buttons choose a kind and the form sends the active chip', async () => {
  const { nodes, posts } = await loadGrid([]);
  const form = nodes.get('watch-form');
  const submit = async (input) => {
    form.elements.input.value = input;
    await form.onsubmit({ preventDefault() {}, currentTarget: form });
  };
  await submit('competitor.example');
  nodes.get('add-project').onclick();
  assert.equal(form.elements.input.focused, true);
  assert.equal(nodes.get('kind-project').attributes.get('aria-pressed'), 'true');
  await submit('project.example');
  nodes.get('kind-competitor').onclick();
  await submit('another.example');
  assert.deepEqual(posts, [
    { input: 'competitor.example', region: null, kind: 'competitor' },
    { input: 'project.example', region: null, kind: 'project' },
    { input: 'another.example', region: null, kind: 'competitor' },
  ]);
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
  assert.equal(regionHeading.textContent, 'Lần chạy gần nhất theo quốc gia');
  assert.deepEqual(countries.children.map((node) => node.textContent), [
    '🇺🇸 Hoa Kỳ · 10/11/2026', '🇻🇳 Việt Nam · 08/11/2026',
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
