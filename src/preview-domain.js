// Đọc tên miền hiển thị của mẫu quảng cáo chữ/video từ tệp xem trước của Google (không cần AI).
const googleHost = /(?:^|\.)(?:google|googleadservices|googlesyndication|doubleclick|gstatic|youtube|ytimg|googlevideo|googleusercontent|ggpht|youtu)\.[a-z.]+$/;

function decodeEscapes(text) {
  return text
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

function cleanHost(value) {
  if (!value) return null;
  let host = value.trim().toLowerCase();
  try {
    host = new URL(/^[a-z]+:\/\//.test(host) ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null;
  return googleHost.test(host) ? null : host;
}

// Máy chủ thư viện/hạ tầng hay xuất hiện trong tệp xem trước — không phải trang của nhà quảng cáo.
const infraHost = /(?:^|\.)(?:w3\.org|ampproject\.org|github\.com|example\.com|schema\.org|googleapis\.com|googletagmanager\.com|cloudflare\.com|jsdelivr\.net|unpkg\.com|fontawesome\.com|jquery\.com|apple\.com|android\.com|mozilla\.org)$/;

function mostLinkedHost(text) {
  const counts = new Map();
  for (const match of text.matchAll(/(?:\/\/|(?<![\w.-])(?=www\.))((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?![\w-])/gi)) {
    const host = cleanHost(match[1]);
    if (!host || infraHost.test(host)) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  let best = null;
  let highest = 1; // phải xuất hiện ít nhất 2 lần mới tin
  for (const [host, count] of counts) if (count > highest) { best = host; highest = count; }
  return best;
}

export function extractPreviewDomain(script) {
  const text = decodeEscapes(String(script ?? ''));
  const keys = ['visible_url', 'destination_url', 'final_url'];
  for (const key of keys) {
    for (const match of text.matchAll(new RegExp(`${key}\\s*[:=]\\s*['"]([^'"]+)['"]`, 'g'))) {
      const host = cleanHost(decodeURIComponent(match[1].replace(/%(?![0-9a-f]{2})/gi, '%25')));
      if (host) return host;
    }
  }
  return mostLinkedHost(text);
}

export function isPreviewScript(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'displayads-formats.googleusercontent.com' && parsed.pathname.endsWith('/content.js');
  } catch {
    return false;
  }
}
