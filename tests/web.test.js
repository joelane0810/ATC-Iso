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
  querySelector(selector) {
    assert.equal(selector, '[aria-pressed="true"]');
    return this.children.find((child) => child.attributes.get('aria-pressed') === 'true');
  }
  scrollIntoView() { this.scrolled = true; }
}

const creative = {
  creativeId: 'CR1', watchIds: ['example-com'], domain: 'example.com', advertiserName: 'Example',
  format: 'image', firstShown: '2026-11-08T00:00:00Z', lastShown: '2026-11-10T00:00:00Z',
  isNew: true, isRunning: false, detailsUrl: 'https://adstransparency.google.com/advertiser/AR1/creative/CR1',
};

async function loadGrid(results) {
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
  await runInNewContext(script, {
    document, URLSearchParams, clearTimeout,
    navigator: { clipboard: { writeText: async (value) => clipboard.push(value) } },
    Option: class {},
    fetch: async (path) => ({
      ok: true,
      json: async () => {
        if (path === '/api/status') return { scanning: false };
        if (path === '/api/profiles') return [{ id: 'dai', name: 'Dai' }];
        if (path.endsWith('/watchlist')) {
          return [{ id: 'example-com', label: 'example.com', value: 'example.com', type: 'domain' }];
        }
        return results;
      },
    }),
  });
  assert.equal(nodes.get('error').hidden, true);
  return { cards: nodes.get('ads').children, detail: nodes.get('detail'), nodes, clipboard };
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
  assert.equal(cards[1].children[1].children[3].children.length, 0);
});

test('watch selection includes shared ads and can return to all ads', async () => {
  const { nodes } = await loadGrid([
    { ...creative, watchId: 'another-watch' },
    { ...creative, creativeId: 'CR2', watchId: 'example-com', watchIds: undefined },
    { ...creative, creativeId: 'CR3', watchIds: ['another-watch'] },
  ]);
  const [all, watch] = nodes.get('watches').children.map((row) => row.children[0]);
  assert.equal(nodes.get('ads').children.length, 3);
  watch.onclick();
  assert.equal(watch.attributes.get('aria-pressed'), 'true');
  assert.equal(nodes.get('gallery-heading').textContent, 'example.com');
  assert.equal(nodes.get('gallery-summary').textContent, 'example.com · 2 mẫu quảng cáo');
  assert.equal(nodes.get('ads').children.length, 2);
  all.onclick();
  assert.equal(nodes.get('ads').children.length, 3);
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
