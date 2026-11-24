import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countryIsoCodes } from './atc.js';

const langPath = fileURLToPath(new URL('../vendor/ocr/', import.meta.url));
const googleDomain = /(?:^|\.)(?:google|youtube|gstatic|googlesyndication|doubleclick)\.(?:com|net|org|[a-z]{2}|(?:com|co)\.[a-z]{2})$/;

export function extractDomain(text) {
  const normalized = text.toLowerCase().replace(
    /(?<=[a-z0-9])[^\S\r\n]+\.(?=(?:com|net|org|io|co|vn)\b)/g, '.',
  );
  const counts = new Map();
  for (const [match] of normalized.matchAll(
    /(?<![a-z0-9@_-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?![a-z0-9_-])/g,
  )) {
    const domain = match.replace(/^www\./, '');
    if (!domain.includes('.') || googleDomain.test(domain)) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  let best = null;
  let highest = 0;
  for (const [domain, count] of counts) {
    if (count <= highest) continue;
    best = domain;
    highest = count;
  }
  return best;
}

// Đuôi tên miền hợp lệ: mọi mã quốc gia + các đuôi chung hay gặp. OCR đọc sai (".con", ".on") sẽ bị loại.
const genericTlds = `com net org info biz io co ai app dev shop store online site tech pro club top xyz me tv cc ws
  ly gg so to fm vip live life world today news blog cloud digital agency studio design media group global
  solutions services company business money finance capital fund bank loans credit insurance trade trading
  markets exchange crypto bet casino games game play fun win best deals sale buy market express plus one
  academy education school college university courses training health care clinic dental fit fitness beauty
  spa salon fashion style shoes clothing jewelry watch watches gold diamonds homes house realestate property
  rentals travel tours holiday vacations hotel flights auto cars car parts tools energy solar green eco
  email chat link click page website web host space network systems software codes guru expert ninja
  photo photos pics art gallery music video movie film tube social family love dating wedding baby kids
  pet pets dog food restaurant cafe coffee pizza bar wine beer farm garden law legal tax accountant
  consulting marketing ventures partners holdings international ltd llc inc gmbh asia eu africa lat`;
const validTlds = new Set([...genericTlds.split(/\s+/), ...countryIsoCodes().map(code => code.toLowerCase()), 'uk']);

export function hasValidTld(domain) {
  return validTlds.has(String(domain).split('.').pop());
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

// Sửa tên miền đọc từ ảnh: khớp gần đúng với tên miền đã biết của cùng nhà quảng cáo
// (vd. "bechoneyspa.com" → "beehoneyspa.com"), sửa đuôi đọc nhầm, loại đuôi không tồn tại.
export function normalizeOcrDomain(domain, known = []) {
  if (!domain) return null;
  let value = String(domain).toLowerCase().replace(/\.(?:con|corn|cm|c0m|coom)$/, '.com');
  if (known.includes(value)) return value;
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const distance = editDistance(value, candidate);
    const allowed = Math.min(2, Math.floor(candidate.length / 6));
    if (distance <= allowed && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best) return best;
  return hasValidTld(value) ? value : null;
}

// Quảng cáo ứng dụng không có tên miền: ảnh chụp ghi "Google Play" / "App Store" — gom về cửa hàng tương ứng.
export function extractAppStore(text) {
  if (/google\s*play/i.test(text)) return 'play.google.com';
  if (/app\s*store/i.test(text)) return 'apps.apple.com';
  return null;
}

export async function createDomainReader() {
  await access(join(langPath, 'eng.traineddata'));
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, {
    langPath, gzip: false, cacheMethod: 'none',
    errorHandler: () => {}, // Recognition failures also reject the recognize promise.
  });
  return {
    async read(bufferOrPath) {
      const { data } = await worker.recognize(bufferOrPath);
      return extractDomain(data.text);
    },
    // Ảnh chụp bản xem trước (chữ/video): tên miền hiển thị, hoặc cửa hàng ứng dụng nếu là quảng cáo app.
    async readSnapshot(bufferOrPath) {
      const { data } = await worker.recognize(bufferOrPath);
      return extractDomain(data.text) ?? extractAppStore(data.text);
    },
    close: () => worker.terminate(),
  };
}
