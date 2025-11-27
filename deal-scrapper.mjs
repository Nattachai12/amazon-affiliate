// scrape-deals.mjs
//
// Usage:
//   node scrape-deals.mjs deals.txt
//
// Behavior:
//   - Reads deals.txt (or file passed as 1st arg) with one Amazon product URL per line
//   - Uses ONE browser tab, sequentially visiting each URL
//   - Simulates human-like behavior (random viewport, user agent, scrolling, mouse movement, delays)
//   - Captures main product image screenshot into ./screenshots/
//   - Deletes existing deals.json, then writes a new sorted deals.json in the same directory
//
// Optional env vars:
//   AMAZON_ASSOCIATE_TAG   -> affiliate tag (otherwise no tag added)
//   HTTP_PROXY / HTTPS_PROXY -> proxy server URL (e.g. http://user:pass@host:port)

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const AFFILIATE_TAG = process.env.AMAZON_ASSOCIATE_TAG || '';

const USER_AGENTS = [
  // A few common-ish desktop Chrome user agents
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function extractASINFromUrl(url) {
  const dpMatch = url.match(/\/dp\/([A-Z0-9]{10})/i);
  if (dpMatch) return dpMatch[1];
  const gpMatch = url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  if (gpMatch) return gpMatch[1];
  return null;
}

function parsePriceText(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^\d.,]/g, '').replace(',', '');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function computeDiscount(original, current) {
  if (original == null || current == null) {
    return { hasDiscount: false, pct: null, save: null };
  }
  if (current >= original) {
    return { hasDiscount: false, pct: 0, save: 0 };
  }
  const diff = original - current;
  const pct = +(diff / original * 100).toFixed(2);
  const save = +diff.toFixed(2);
  return { hasDiscount: true, pct, save };
}

async function screenshotMainImage(page, outputDir, asin, index) {
  const selectors = [
    '#imgTagWrapperId img',
    '#landingImage',
    '#main-image-container img',
    '#imgBlkFront'
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      const fileName = `${index + 1}-${asin ?? 'noasin'}.png`;
      const filePath = path.join(outputDir, fileName);
      await el.screenshot({ path: filePath });
      return filePath;
    }
  }
  return null;
}

// Human-like interactions: scroll & mouse moves with random pauses
async function simulateHumanInteraction(page) {
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const scrollSteps = randomInt(2, 5);

  for (let i = 0; i < scrollSteps; i++) {
    const delta = randomInt(200, 800);
    await page.mouse.move(
      randomInt(50, viewport.width - 50),
      randomInt(50, viewport.height - 50),
      { steps: randomInt(5, 15) }
    );
    await page.mouse.move(
      randomInt(50, viewport.width - 50),
      randomInt(50, viewport.height - 50),
      { steps: randomInt(5, 15) }
    );

    await page.evaluate((d) => {
      window.scrollBy(0, d);
    }, delta);

    await page.waitForTimeout(randomInt(500, 1500));
  }

  // Slight scroll up / side move sometimes
  if (Math.random() < 0.4) {
    await page.evaluate(() => {
      window.scrollBy(0, -150);
    });
    await page.waitForTimeout(randomInt(400, 1200));
  }
}

async function scrapeAmazonProduct(page, url, screenshotDir, index) {
  const asin = extractASINFromUrl(url);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Initial small wait
  await page.waitForTimeout(randomInt(1500, 3000));

  // Human-like interaction (scrolling / mouse move)
  await simulateHumanInteraction(page);

  // Ensure title is ready
  await page
    page.locator('span#productTitle')
    .waitFor({ timeout: 10000 })
    .catch(() => {});

  const rawTitle = (
    await page.locator('span#productTitle').textContent().catch((error) => {console.log('catch',error)})
  )?.trim() || null;


  const title = rawTitle || null;
console.log(rawTitle)
  const currentPriceText =
    (await page
      .locator('span.a-price.aok-align-center span.a-offscreen')
      .first()
      .textContent()
      .catch(() => null)) ||
    (await page
      .locator('span.a-price[data-a-color="price"] span.a-offscreen')
      .first()
      .textContent()
      .catch(() => null)) ||
    (await page
      .locator('#corePrice_feature_div span.a-offscreen')
      .first()
      .textContent()
      .catch(() => null));

  const current = parsePriceText(currentPriceText);

  const originalPriceText =
    (await page
      .locator('span.a-price.a-text-price span.a-offscreen')
      .first()
      .textContent()
      .catch(() => null)) ||
    (await page
      .locator('span[data-a-strike="true"] span.a-offscreen')
      .first()
      .textContent()
      .catch(() => null));

  let original = parsePriceText(originalPriceText);
  if (original == null && current != null) original = current;

  const pictureRef =
    (await screenshotMainImage(page, screenshotDir, asin, index)) ?? null;

  const { hasDiscount, pct, save } = computeDiscount(original, current);
  const needCheck =
    !title || !pictureRef || original == null || current == null || asin == null;

  const affiliateLink =
    asin && AFFILIATE_TAG
      ? `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`
      : asin
      ? `https://www.amazon.com/dp/${asin}`
      : null;

  return {
    ASIN: asin,
    Title: title,
    Link: url,
    Original: original,
    Current: current,
    Image: pictureRef,
    NeedCheckManually: needCheck,
    HasDiscount: hasDiscount,
    DiscountPct: pct,
    YouSave: save,
    AffiliateLink: affiliateLink
  };
}

async function main() {
  const inputFile = process.argv[2] || 'deals.txt';
  const txt = await fs.readFile(inputFile, 'utf-8');
  const urls = txt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (urls.length === 0) {
    console.log('No URLs found in input file.');
    return;
  }

  const baseDir = process.cwd();
  const screenshotDir = path.join(baseDir, 'screenshots');
  await fs.mkdir(screenshotDir, { recursive: true });

  const dealsFile = path.join(baseDir, 'deals.json');
  try {
    await fs.unlink(dealsFile);
  } catch {}

  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    undefined;

  const browser = await chromium.launch({
    headless: false,
    proxy: proxy ? { server: proxy } : undefined
  });

  const viewport = {
    width: randomInt(1100, 1600),
    height: randomInt(700, 1000)
  };
  const userAgent = randomChoice(USER_AGENTS);

  const context = await browser.newContext({
    viewport,
    locale: 'en-US',
    userAgent
  });

  for (const p of await context.pages()) {
    await p.close();
  }
  const page = await context.newPage();

  const deals = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const host = new URL(url).hostname;

      if (!host.includes('amazon.')) {
        deals.push({
          ASIN: null,
          Title: null,
          Link: url,
          Original: null,
          Current: null,
          Image: null,
          NeedCheckManually: true,
          HasDiscount: false,
          DiscountPct: null,
          YouSave: null,
          AffiliateLink: null
        });
        continue;
      }

      const deal = await scrapeAmazonProduct(page, url, screenshotDir, i);
      deals.push(deal);

      // Random delay between pages (3–10 seconds)
      await page.waitForTimeout(randomInt(3000, 10000));
    } catch {
      deals.push({
        ASIN: extractASINFromUrl(url),
        Title: null,
        Link: url,
        Original: null,
        Current: null,
        Image: null,
        NeedCheckManually: true,
        HasDiscount: false,
        DiscountPct: null,
        YouSave: null,
        AffiliateLink: null
      });
    }
  }

  await browser.close();

  const sortedDeals = deals.sort(
    (a, b) => (b.DiscountPct ?? 0) - (a.DiscountPct ?? 0)
  );

  const json = JSON.stringify(sortedDeals, null, 2);
  await fs.writeFile(dealsFile, json, 'utf-8');
  console.log(`Saved JSON → ${dealsFile}`);
}

main().catch((err) => {
  console.error('Error in script:', err);
  process.exit(1);
});
