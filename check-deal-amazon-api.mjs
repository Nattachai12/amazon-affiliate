import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/** ============ Config ============ **/
const ITEMS_PER_BATCH = 10;                 // PA-API GetItems max = 10
const SLEEP_BETWEEN_BATCHES_MS = 1_250;     // ~1 req/sec safety
const INPUT_DIR = './DoNotDelete-MyListInput';
const OUTPUT_ROOT = './output';

const REGION = process.env.PAAPI_REGION || 'us-east-1';
const HOST = process.env.PAAPI_HOST || 'webservices.amazon.com';
const SERVICE = 'ProductAdvertisingAPI';
const AMZ_TARGET = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems';
const PATHNAME = '/paapi5/getitems';

/** ============ Helpers ============ **/
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

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

/** ============ PA-API Signing ============ **/
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function sha256Hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

function buildAuthHeaders({ accessKey, secretKey, region, service, host, amzTarget, path, payload }) {
  const method = 'POST';
  const content = JSON.stringify(payload);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z'; // YYYYMMDDThhmmssZ
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders =
    `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:${amzTarget}\n`;
  const signedHeaders = 'content-encoding;content-type;host;x-amz-date;x-amz-target';

  const canonicalRequest = [
    method,
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(content),
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(Buffer.from('AWS4' + secretKey, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authHeader = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    method,
    headers: {
      'content-encoding': 'amz-1.0',
      'content-type': 'application/json; charset=utf-8',
      'host': host,
      'x-amz-date': amzDate,
      'x-amz-target': amzTarget,
      'Authorization': authHeader,
    },
    body: content,
  };
}

/** ============ PA-API Fetch ============ **/
async function fetchPaapiItems(asins) {
  const ACCESS_KEY = process.env.PAAPI_ACCESS_KEY;
  const SECRET_KEY = process.env.PAAPI_SECRET_KEY;
  const PARTNER_TAG = process.env.PAAPI_PARTNER_TAG;

  if (!ACCESS_KEY || !SECRET_KEY || !PARTNER_TAG) {
    throw new Error('PA-API credentials missing: ensure PAAPI_ACCESS_KEY, PAAPI_SECRET_KEY, PAAPI_PARTNER_TAG are set.');
  }

  const payload = {
    ItemIds: asins,
    PartnerTag: PARTNER_TAG,
    PartnerType: 'Associates',
    Resources: [
      'ItemInfo.Title',
      'Offers.Listings.Price',
      'Offers.Listings.SavingBasis',
      'Images.Primary.Large',
      'DetailPageURL',
    ],
  };

  const reqInit = buildAuthHeaders({
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    region: REGION,
    service: SERVICE,
    host: HOST,
    amzTarget: AMZ_TARGET,
    path: PATHNAME,
    payload,
  });

  const url = `https://${HOST}${PATHNAME}`;
  const res = await fetch(url, reqInit);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PA-API error ${res.status}: ${text || res.statusText}`);
  }
  const data = await res.json();
  // ItemsResult.Items (array) + Errors maybe present
  const items = data.ItemsResult?.Items || [];
  return items;
}

function summarizePA(item, linkFallback) {
  const title = item.ItemInfo?.Title?.DisplayValue || item.ASIN;
  const listing = item.Offers?.Listings?.[0];

  const current = listing?.Price?.Amount ?? null;
  const original = listing?.SavingBasis?.Amount ?? null; // Amazon's "was" price when savings shown

  const imageUrl = item.Images?.Primary?.Large?.URL || null;
  const link = item.DetailPageURL || linkFallback || (item.ASIN ? `https://www.amazon.com/dp/${item.ASIN}` : null);

  const needCheckManually = !(Number.isFinite(current) && current > 0) || !(Number.isFinite(original) && original > 0);

  const discountPct = pct(original, current);
  const discountAmt = (original && current) ? original - current : 0;
  const hasDiscount = discountAmt > 0;

  return {
    source: 'paapi',
    asin: item.ASIN,
    title,
    link,
    original,
    current,
    discountPct,
    discountAmt,
    needCheckManually,
    imageUrl,
    hasDiscount,
  };
}

/** ====== Rate Limiter (global) ====== **/
let lastFetchAt = 0;
async function throttlePaapi() {
  const now = Date.now();
  const elapsed = now - lastFetchAt;
  if (elapsed < SLEEP_BETWEEN_BATCHES_MS) {
    const waitMs = SLEEP_BETWEEN_BATCHES_MS - elapsed;
    console.log(`⏳ Waiting ${Math.ceil(waitMs / 1000)}s to respect PA-API rate limits...`);
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
    .filter(Boolean);

  const asinToLink = new Map();
  const asins = [];
  const asinSeen = new Map();
  const duplicates = [];

  // Detect duplicates (per file)
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
    duplicates.forEach(d => console.log(`   - ASIN ${d.asin} appears on lines ${d.line1} and ${d.line2}`));
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
    await throttlePaapi();

    let items;
    try {
      items = await fetchPaapiItems(batch);
    } catch (err) {
      console.error(`❌ ERROR: PA-API fetch failed for ${baseNameWithExt} batch ${i + 1}. ${err?.message || err}`);
      throw err;
    }

    const results = items.map(it => summarizePA(it, asinToLink.get(it.ASIN)));

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
async function main() {
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
    const txtFiles = entries
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.txt'))
      .map(e => path.join(INPUT_DIR, e.name));

    if (!txtFiles.length) {
      console.log(`⚠️  No .txt files found in "${INPUT_DIR}".`);
      console.log('✅ SUCCESS: Completed (no input files).');
      return;
    }

    console.log(`🗂️ Found ${txtFiles.length} file(s):`);
    txtFiles.forEach(f => console.log(' -', path.basename(f)));

    const outRootAbs = path.resolve(OUTPUT_ROOT);
    for (const file of txtFiles) {
      await processTxtFile(file, outRootAbs);
    }

    console.log('\n✅ SUCCESS: All files processed. Output root:', outRootAbs);
  } catch (err) {
    console.error('\n❌ ERROR: Program aborted due to an unrecoverable error.');
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
}

main();
// run: node check-deal-amazon-api.mjs
