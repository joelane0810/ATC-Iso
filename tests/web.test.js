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
    return this.children.flatMap((grid) => grid.children)
      .find((child) => child.attributes.get('aria-pressed') === 'true');
  }
  scrollIntoView() { this.scrolled = true; }
}

const creative = {
  creativeId: 'CR1', platform: 'search', watchIds: ['example-com'], domain: 'example.com', advertiserName: 'Example',
  format: 'image', firstShown: '2026-11-08T00:00:00Z', lastShown: '2026-11-10T00:00:00Z',
  isNew: true, isRunning: false, detailsUrl: 'https://adstransparency.google.com/advertiser/AR1/creative/CR1',
};

async function loadGrid(results, overview = {}) {
  const posts = [];
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
  document.getElementById('gallery').children = ['ads', 'new-ads', 'stopped-ads'].map(document.getElementById);
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
            previousScanAt: null, totals: { new: 1, stopped: 1, running: 2 },
            byWatch: [
              { watchId: 'example-com', label: 'example.com', new: 1, stopped: 1, running: 1, total: 2 },
              { watchId: 'project', label: 'Dự án A', kind: 'project', new: 0, stopped: 0, running: 1, total: 1 },
            ],
            newAds: results, stoppedAds: [], ...overview,
          };
        }
        return results;
      },
    }),
  });
  assert.equal(nodes.get('error').hidden, true);
  return { cards: nodes.get('new-ads').children, detail: nodes.get('detail'), nodes, clipboard, posts };
}

test('grid prefers a local image, then a remote image, then the placeholder', async () => {
  const imageUrl = 'https://example.com/remote.png';
  const { cards } = await loadGrid([
    { ...creative, image: 'images/CR1.png', imageUrl },
    { ...creative, creativeId: 'CR2', imageUrl },
    { ...creative, creativeId: 'CR3' },
  ]);
  assert.equal(cards[0].children[0].src, '/images/CR1.png');
  assert.equal(cards[1].children[0].src, imageUrl);
  assert.equal(cards[2].children[0].children[1].textContent, 'Chưa có ảnh xem trước');
});

test('cards show advertiser, website, Vietnamese dates and applicable badges', async () => {
  const { cards } = await loadGrid([
    creative,
    { ...creative, creativeId: 'CR2', domain: null, format: 'video', isNew: false, isRunning: true },
  ]);
  const [name, domain, dates, badges] = cards[0].children[1].children;
  assert.deepEqual([name.textContent, domain.textContent, dates.textContent], [
    'Example', 'example.com', 'Bắt đầu 08/11/2026 · Gần nhất 10/11/2026',
  ]);
  assert.deepEqual(badges.children.map((node) => node.textContent), ['Mới', 'Đã dừng']);
  assert.deepEqual(cards[1].children[1].children[3].children.map((node) => node.textContent), ['Mới']);
});

test('home uses summary and opens competitor and project galleries from rows or the sidebar', async () => {
  const { nodes, detail } = await loadGrid([
    { ...creative, watchId: 'another-watch' },
    { ...creative, creativeId: 'CR2', watchId: 'example-com', watchIds: undefined },
    { ...creative, creativeId: 'CR3', watchId: 'example-com', platform: 'display' },
  ], {
    previousScanAt: '2026-11-21T19:05:00Z',
    stoppedAds: [{ ...creative, creativeId: 'CR4', domain: 'stopped.example' }],
  });
  assert.equal(nodes.get('gallery-heading').textContent, 'Tổng quan thay đổi');
  assert.equal(nodes.get('gallery-summary').textContent, 'So với lượt quét trước lúc 02:05 22/11');
  assert.equal(nodes.get('total-running').textContent, '2');
  assert.equal(nodes.get('new-ads').children.length, 2);
  const stopped = nodes.get('stopped-ads').children[0];
  stopped.onclick();
  assert.equal(detail.children[1].children[3].textContent, 'stopped.example');
  const watchChoice = (kind) => nodes.get('watches-' + kind).children[0].children[0];
  assert.equal(watchChoice('competitor').children[1].textContent, '2 mẫu');
  assert.equal(watchChoice('project').children[0].textContent, 'Dự án A');
  const project = nodes.get('changes').children[1];
  assert.equal(project.children[1].textContent, 'Dự án');
  project.onclick();
  assert.equal(nodes.get('gallery-heading').textContent, 'Dự án A');
  assert.equal(watchChoice('project').attributes.get('aria-pressed'), 'true');
  watchChoice('competitor').onclick();
  assert.equal(watchChoice('competitor').attributes.get('aria-pressed'), 'true');
  assert.equal(nodes.get('gallery-summary').textContent, 'example.com · 2 mẫu quảng cáo');
  assert.equal(nodes.get('ads').children.length, 2);
  nodes.get('home').onclick();
  assert.equal(nodes.get('overview').hidden, false);
  assert.equal(nodes.get('watch-view').hidden, true);
});

test('the add buttons choose a kind and the form sends the active chip', async () => {
  const { nodes, posts } = await loadGrid([]);
  assert.equal(nodes.get('gallery-summary').textContent, 'Chưa có lượt quét trước');
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
  const { cards, detail, clipboard } = await loadGrid([
    { ...creative, imageUrl },
    { ...creative, creativeId: 'CR2', domain: 'other.com' },
  ]);
  assert.match(detail.textContent, /Chọn một mẫu/);
  cards[0].onclick();
  const [image, fields, actions] = detail.children;
  const [link, copy] = actions.children;
  assert.equal(image.src, imageUrl);
  assert.deepEqual(fields.children.map((node) => node.textContent), [
    'Nhà quảng cáo', 'Example', 'Website', 'example.com', 'Định dạng', 'Hình ảnh',
    'Bắt đầu chạy', '08/11/2026', 'Lần chạy gần nhất', '10/11/2026',
    'Số ngày chạy', '3', 'Trạng thái', 'Đã dừng',
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
