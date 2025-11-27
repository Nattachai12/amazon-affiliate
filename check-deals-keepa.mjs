import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

/** ============ Config ============ **/
const DOMAIN = 1; // Keepa US
const ITEMS_PER_BATCH = 20;
const SLEEP_BETWEEN_BATCHES_MS = 60_000; // 1 minute
const INPUT_DIR = './DoNotDelete-MyListInput';
const OUTPUT_ROOT = './output';
const AFFILIATE_TAG = process.env.AMAZON_ASSOCIATE_TAG || '';
const AFFILIATE_DOMAIN = process.env.AMAZON_ASSOCIATE_DOMAIN || 'www.amazon.com';
/**
 * If you put filenames in here (e.g. ["list1.txt", "christmas-deals.txt"]),
 * ONLY those files will be processed.
 * If this array is empty, ALL .txt files in INPUT_DIR will be processed.
 */
const SELECTED_TXT_FILES = ['apple.txt', 'sony.txt', 'today.txt'];

/** ============ Helpers ============ **/

function normalizeUrl(raw) {
  let url = raw.trim();
  if (!url) return url;

  // Already has protocol → leave as is
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  // Short Amazon redirect links: amzn.to/xxxx → add https://
  if (/^amzn\.to\//i.test(url)) {
    return `https://${url}`;
  }

  // Starts with www. → just add https://
  if (/^www\./i.test(url)) {
    return `https://${url}`;
  }

  // Starts with amazon.com (no www) → add https://www.
  if (/^amazon\.com\//i.test(url)) {
    return `https://www.${url}`;
  }

  // Starts with amazon.<something> (fallback)
  if (/^amazon\./i.test(url)) {
    return `https://www.${url.replace(/^amazon\./i, 'amazon.')}`;
  }

  // Fallback: if no protocol, at least add https://
  return `https://${url}`;
}


function buildAffiliateLink(asin) {
  // No tag set → just return a plain dp link
  if (!AFFILIATE_TAG) {
    return `https://${AFFILIATE_DOMAIN}/dp/${asin}`;
  }

  return `https://${AFFILIATE_DOMAIN}/dp/${asin}?tag=${AFFILIATE_TAG}`;
}


function extractASIN(url) {
  try {
    const u = new URL(url);
    const m1 = u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([A-Z0-9]{10})/i);
    if (m1) return m1[1].toUpperCase();
    const m2 = u.pathname.match(/\/([A-Z0-9]{10})(?:[/?#]|$)/i);
    if (m2) return m2[1].toUpperCase();
    const qp = u.searchParams.get('asin') || u.searchParams.get('ASIN');
    if (qp && /^[A-Z0-9]{10}$/i.test(qp)) return qp.toUpperCase();
    return null;
  } catch {
    const m = url.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/gp\/offer-listing\/)([A-Z0-9]{10})/i);
    return m ? m[1].toUpperCase() : null;
  }
}

function fmtUsd(price) { return price == null ? null : Number(Number(price).toFixed(2)); }
function pct(originalPrice, currentPrice) { return (originalPrice && currentPrice) ? ((originalPrice - currentPrice) / originalPrice) * 100 : 0; }
function keepaToUSD(p) { return (!Number.isFinite(p) || p <= 0) ? null : Number((p / 100).toFixed(2)); }
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

/** ============ Keepa ============ **/
async function fetchKeepaProducts(asins) {
  const key = process.env.KEEPA_KEY;
  if (!key) return [];
  const url = `https://api.keepa.com/product?key=${key}&domain=${DOMAIN}&asin=${asins.join(',')}&stats=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Keepa error ${res.status}`);
  const data = await res.json();
  return data.products || [];
}

function getKeepaImageUrl(product, size = 'l') {
  const img = product.images?.[0];
  if (!img) return null;
  const name = img[size];
  return name ? `https://m.media-amazon.com/images/I/${name}` : null;
}

function summarizeKeepa(product, link) {
  const title = product.title || product.asin;
  const c = product.stats?.current?.[0];
  const o = product.stats?.current?.[4];
  const avg = product.stats?.avg90?.[0];
  const hasC = Number.isFinite(c) && c > 0;
  const hasO = Number.isFinite(o) && o > 0;
  const needCheckManually = !hasC || !hasO;
  const current = keepaToUSD(c);
  const original = keepaToUSD(o ?? avg ?? null);
  const discountPct = pct(original, current);
  const discountAmt = (original && current) ? original - current : 0;
  const hasDiscount = discountAmt > 0;
  const affiliateLink = buildAffiliateLink(product.asin);
  return {
    source: 'keepa',
    asin: product.asin,
    title,
    link,
    original,
    current,
    discountPct,
    discountAmt,
    needCheckManually,
    imageUrl: getKeepaImageUrl(product),
    hasDiscount,
    affiliateLink
  };
}

/** ====== Rate Limiter ====== **/
let lastFetchAt = 0;
async function throttleKeepa() {
  const now = Date.now();
  const elapsed = now - lastFetchAt;
  if (elapsed < SLEEP_BETWEEN_BATCHES_MS) {
    const waitMs = SLEEP_BETWEEN_BATCHES_MS - elapsed;
    console.log(`⏳ Waiting ${Math.ceil(waitMs / 1000)}s to respect Keepa rate limits...`);
    await sleep(waitMs);
  }
  lastFetchAt = Date.now();
}

/** ============ File Processing ============ **/
async function processTxtFile(filePath, outRootAbs) {
  const baseNameWithExt = path.basename(filePath);
  const baseName = baseNameWithExt.replace(/\.[^/.]+$/, '');
  const outDir = path.join(outRootAbs, baseName);
  await fs.mkdir(outDir, { recursive: true });

  const lines = (await fs.readFile(filePath, 'utf8'))
  .split('\n')
  .map(l => l.trim())
  .filter(Boolean)
  .map(normalizeUrl);

  const asinToLink = new Map();
  const asins = [];
  const asinSeen = new Map();
  const duplicates = [];

  // Detect duplicates
  lines.forEach((url, idx) => {
    const asin = extractASIN(url);
    if (!asin) return;
    if (asinSeen.has(asin)) {
      duplicates.push({ asin, line1: asinSeen.get(asin), line2: idx + 1 });
    } else {
      asinSeen.set(asin, idx + 1);
      asins.push(asin);
      asinToLink.set(asin, url);
    }
  });

  if (duplicates.length) {
    console.log(`⚠️  Duplicates found in ${baseNameWithExt}:`);
    duplicates.forEach(d => {
      console.log(`   - ASIN ${d.asin} appears on lines ${d.line1} and ${d.line2}`);
    });
  }

  if (asins.length === 0) {
    console.log(`⚠️  No valid ASINs found in ${baseNameWithExt}.`);
    return;
  }

  const batches = chunk(asins, ITEMS_PER_BATCH);
  console.log(`\n📄 ${baseNameWithExt}: ${asins.length} unique ASIN(s) → ${batches.length} batch(es)`);

  let processed = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const startIdx = processed + 1;
    const endIdx = processed + batch.length;

    console.log(`🔎 ${baseNameWithExt} — Batch ${i + 1}/${batches.length}: ASINs ${startIdx}-${endIdx}`);
    await throttleKeepa();

    let keepaItems;
    try {
      keepaItems = await fetchKeepaProducts(batch);
    } catch (err) {
      console.error(`❌ ERROR: Keepa fetch failed for ${baseNameWithExt} batch ${i + 1}. ${err?.message || err}`);
      throw err;
    }

    const results = keepaItems.map(p => summarizeKeepa(p, asinToLink.get(p.asin)));

    const dealRows = results.map(r => ({
      ASIN: r.asin,
      Title: r.title || r.asin,
      Link: r.link,
      Original: fmtUsd(r.original),
      Current: fmtUsd(r.current),
      Image: r.imageUrl,
      NeedCheckManually: r.needCheckManually,
      HasDiscount: r.hasDiscount,
      DiscountPct: r.discountPct != null ? Number(r.discountPct.toFixed(2)) : null,
      YouSave: fmtUsd(r.discountAmt),
      AffiliateLink: r.affiliateLink,
    }));

    const outFile = path.join(outDir, `${baseName}${startIdx}-${endIdx}.json`);
    try {
      await fs.access(outFile);
      console.log(`♻️ Overwriting existing file: ${outFile}`);
    } catch {}
    try {
      await fs.writeFile(outFile, JSON.stringify(dealRows, null, 2));
      console.log(`💾 Saved ${outFile} (${dealRows.length} items)`);
    } catch (err) {
      console.error(`❌ ERROR: Failed to write ${outFile}. ${err?.message || err}`);
      throw err;
    }

    processed += batch.length;
  }

  console.log(`✅ Finished ${baseNameWithExt}. Output: ${outDir}/`);
}

/** ============ Main ============ **/
async function main(selectedFiles = SELECTED_TXT_FILES) {
  try {
    await fs.access(INPUT_DIR).catch(() => {
      console.error(`❌ ERROR: Input directory "${INPUT_DIR}" not found.`);
      process.exit(1);
    });

    // Clean and recreate output/
    await fs.rm(OUTPUT_ROOT, { recursive: true, force: true });
    console.log(`🧹 Removed existing "${OUTPUT_ROOT}" (if any).`);
    await fs.mkdir(OUTPUT_ROOT, { recursive: true });
    console.log(`📁 Created fresh "${OUTPUT_ROOT}/"`);

    const entries = await fs.readdir(INPUT_DIR, { withFileTypes: true });

    let txtFiles = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.txt'))
      .map((e) => path.join(INPUT_DIR, e.name));

    // If selectedFiles array is not empty, filter to only those filenames
    if (Array.isArray(selectedFiles) && selectedFiles.length > 0) {
      const selectedSet = new Set(selectedFiles.map((name) => name.toLowerCase()));
      txtFiles = txtFiles.filter((filePath) =>
        selectedSet.has(path.basename(filePath).toLowerCase()),
      );
    }

    if (!txtFiles.length) {
      console.log(
        `⚠️  No .txt files to process. (Either none in "${INPUT_DIR}" or none matched SELECTED_TXT_FILES)`,
      );
      console.log('✅ SUCCESS: Completed (no input files).');
      return;
    }

    console.log(`🗂️ Found ${txtFiles.length} file(s) to process:`);
    txtFiles.forEach((f) => console.log(' -', path.basename(f)));

    const outRootAbs = path.resolve(OUTPUT_ROOT);
    for (const file of txtFiles) await processTxtFile(file, outRootAbs);

    console.log('\n✅ SUCCESS: All files processed. Output root:', outRootAbs);
  } catch (err) {
    console.error('\n❌ ERROR: Program aborted due to an unrecoverable error.');
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
}

export async function runKeepaScript() {
  await main();
}
main();
// run: node check-deals-keepa.mjs