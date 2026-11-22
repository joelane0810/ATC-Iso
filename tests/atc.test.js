import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  RPC_BASE, BlockedError, parseWatchInput, buildSearchCreativesReq,
  parseCreatives, parseSuggestions, isBlockedResponse, slugify,
} from '../src/atc.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('parseWatchInput normalizes domains and advertiser IDs', () => {
  assert.deepEqual(parseWatchInput('https://WWW.Gymshark.com/x?y'), {
    type: 'domain', value: 'gymshark.com',
  });
  assert.deepEqual(parseWatchInput('https://adstransparency.google.com/advertiser/AR123?region=US'), {
    type: 'advertiser', value: 'AR123',
  });
  assert.deepEqual(parseWatchInput('AR016'), { type: 'advertiser', value: 'AR016' });
  assert.throws(() => parseWatchInput('abc'), {
    message: 'Không nhận ra tên miền hoặc link nhà quảng cáo',
  });
  assert.equal(slugify(' Hãng Nike '), 'hang-nike');
});

test('buildSearchCreativesReq includes the matching selector, region and token', () => {
  assert.deepEqual(buildSearchCreativesReq({ watch: { type: 'domain', value: 'nike.com' } }), {
    2: 40, 3: { 12: { 1: 'nike.com', 2: true }, 14: [3] }, 7: { 1: 1, 2: 30, 3: 2840 },
  });
  assert.deepEqual(buildSearchCreativesReq({
    watch: { type: 'advertiser', value: 'AR016', region: 2840 },
    pageToken: 'next', pageSize: 10,
  }), {
    2: 10, 3: { 8: [2840], 13: { 1: ['AR016'] }, 14: [3] }, 4: 'next', 7: { 1: 1, 2: 30, 3: 2840 },
  });
});

test('parseCreatives reads fixtures and normalizes dates and previews', () => {
  const { ads, nextToken } = parseCreatives(JSON.parse(fixture('search-creatives.json')));
  assert.equal(ads.length, 3);
  assert.equal(nextToken, 'CgoAPAGEtoken==');
  assert.deepEqual(ads.map(({ format }) => format), ['text', 'image', 'video']);
  assert.equal(ads[0].firstShown, new Date(1794881634 * 1000).toISOString());
  assert.match(ads[0].previewUrl, /content\.js\?/);
  assert.equal(ads[1].imageUrl, 'https://tpc.googlesyndication.com/archive/simgad/11385273875406013460');
  assert.equal(ads[1].detailsUrl, 'https://adstransparency.google.com/advertiser/AR01437837420136497153/creative/CR17342842963587235841');
  assert.equal(parseCreatives(JSON.parse(fixture('search-creatives-last.json'))).nextToken, null);
});

test('parseCreatives tolerates missing fields', () => {
  const { ads: [ad] } = parseCreatives({ 1: [{ 1: 'AR1', 2: 'CR1', 4: 3 }] });
  for (const field of ['firstShown', 'lastShown', 'previewUrl', 'imageUrl']) {
    assert.equal(ad[field], null);
  }
});

test('parseSuggestions reads advertisers and domains', () => {
  assert.deepEqual(parseSuggestions(JSON.parse(fixture('search-suggestions.json'))), [
    { type: 'advertiser', id: 'AR16989736393464872961', name: "NIKETA'S COMPANY S.R.L.", country: 'MD' },
    { type: 'domain', value: 'nike.com' },
    { type: 'domain', value: 'nike.com.pe' },
  ]);
});

test('isBlockedResponse detects redirects, rate limits and HTML', () => {
  assert.equal(RPC_BASE, 'https://adstransparency.google.com/anji/_/rpc');
  assert.ok(new BlockedError() instanceof Error);
  assert.equal(isBlockedResponse({ status: 302, url: 'https://www.google.com/sorry/index' }), true);
  assert.equal(isBlockedResponse({ status: 429 }), true);
  assert.equal(isBlockedResponse({ status: 200, text: fixture('blocked.html') }), true);
  assert.equal(isBlockedResponse({ status: 200, text: '{"1":[]}' }), false);
});
