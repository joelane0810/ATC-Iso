const ATC = 'https://adstransparency.google.com';

export const RPC_BASE = `${ATC}/anji/_/rpc`;

export class BlockedError extends Error {
  constructor(message = 'Bị chặn') {
    super(message);
    this.name = 'BlockedError';
  }
}

function parseUrl(input) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

export function parseWatchInput(str) {
  const input = str.trim();
  if (/^AR\d+$/i.test(input)) {
    return { type: 'advertiser', value: input.toUpperCase() };
  }

  const url = parseUrl(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
    const domain = url.hostname.replace(/^www\./, '').replace(/\.$/, '');
    const advertiser = url.pathname.match(/^\/advertiser\/(AR\d+)(?:\/|$)/i);
    if (domain === 'adstransparency.google.com' && advertiser) {
      return { type: 'advertiser', value: advertiser[1].toUpperCase() };
    }
    if (/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z][a-z\d-]{0,62}$/i.test(domain)) {
      return { type: 'domain', value: domain };
    }
  }
  throw new Error('Không nhận ra tên miền hoặc link nhà quảng cáo');
}

export function buildSearchCreativesReq({ watch, pageToken = null, pageSize = 40 }) {
  const selector = watch.type === 'domain'
    ? { 12: { 1: watch.value, 2: true } }
    : { 13: { 1: [watch.value] } };
  if (watch.region != null) selector[8] = [watch.region];

  const request = { 2: pageSize, 3: selector, 7: { 1: 1, 2: 30, 3: 2840 } };
  if (pageToken != null) request[4] = pageToken;
  return request;
}

function timestampToIso(seconds) {
  if (seconds == null || seconds === '') return null;
  const date = new Date(Number(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseCreatives(json) {
  const formats = { 1: 'text', 2: 'image', 3: 'video' };
  const ads = (json?.[1] ?? []).map((creative) => {
    const advertiserId = creative[1];
    const creativeId = creative[2];
    const previewHtml = creative[3]?.[3]?.[2];
    const image = previewHtml?.match(/<img\b[^>]*?\s+src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    return {
      creativeId,
      advertiserId,
      advertiserName: creative[12] ?? null,
      domain: creative[14] ?? null,
      format: formats[creative[4]] ?? null,
      previewUrl: creative[3]?.[1]?.[4] ?? null,
      imageUrl: image?.[1] ?? image?.[2] ?? image?.[3] ?? null,
      firstShown: timestampToIso(creative[6]?.[1]),
      lastShown: timestampToIso(creative[7]?.[1]),
      detailsUrl: `${ATC}/advertiser/${advertiserId}/creative/${creativeId}`,
    };
  });
  return { ads, nextToken: json?.[2] || null };
}

export function parseSuggestions(json) {
  const suggestions = [];
  for (const item of json?.[1] ?? []) {
    if (item[1]?.[2]) {
      suggestions.push({ type: 'advertiser', id: item[1][2], name: item[1][1], country: item[1][3] ?? null });
    } else if (item[2]?.[1]) {
      suggestions.push({ type: 'domain', value: item[2][1] });
    }
  }
  return suggestions;
}

export function isBlockedResponse({ status, url = '', text = '' }) {
  return status === 429
    || /^(?:https?:)?\/\/(?:www\.)?google\.com\/sorry(?:[/?#]|$)/i.test(url)
    || /^\s*<(?:!doctype\s+html\b|[a-z][a-z\d:-]*(?=[\s/>])|!--)/i.test(text);
}

export function slugify(str) {
  return str.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replaceAll('đ', 'd')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
