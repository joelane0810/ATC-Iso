import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    close: () => worker.terminate(),
  };
}
