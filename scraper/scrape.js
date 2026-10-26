#!/usr/bin/env node
// Bazaar Price Board scraper worker (staging, v1).
//
// What it does: visits the five shops' PUBLIC pages in a headless browser,
// extracts prices ONLY from structured data on the page (JSON-LD product
// offers, or elements carrying a data-price attribute, plus Agora's known
// allProduct markup), maps them to the board's DEALS variant keys, and
// writes data/prices.json in the same shape /api/live returns:
//   { live, scannedAt, shops: { <key>: { ok, checkedAt, items } } }
//
// Rules, same as the board's:
// - No login, no cart, no checkout, ever. Public pages only.
// - Never guess a price. If a shop yields no structured price data, it is
//   marked ok:false and its PREVIOUS entry from data/prices.json is kept.
// - Scope v1: the 9 core variants from api/prices.js (miniket-loose-kg,
//   miniket-5kg, nazirshail-5kg, moshur-dal-kg, soybean-5L/1L/2L,
//   sugar-1kg, salt-1kg) for every shop, plus unimart-rice-5kg for
//   Unimart. Atta, tea, milk and other cached variants stay on the cached
//   scan until their mapping is added; they are never fabricated here.
// - Unimart rows carry tag "Gulshan-2 only", matching the cached block.
// - Exit 0 when a file was written (even if some shops failed); exit 1
//   only when the file could not be written at all.
//
// Run locally:  cd scraper && npm install && npx playwright install chromium
//               node scrape.js
// On GitHub Actions: see .github/workflows/scrape.yml (every 30 minutes).
// Output path: <repo root>/data/prices.json (this file lives in scraper/).

const fs = require("fs");
const path = require("path");

const OUT_PATH = process.argv[2] || path.join(__dirname, "..", "data", "prices.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SHOPS = [
  { key: "shwapno", name: "Shwapno", urls: ["https://www.shwapno.com/"] },
  { key: "chaldal", name: "Chaldal", urls: ["https://chaldal.com/"] },
  {
    key: "agora",
    name: "Agora",
    urls: [
      "https://agorasuperstores.com/all_products",
      "https://agorasuperstores.com/search?q=" + Buffer.from("miniket rice", "utf8").toString("base64") + "&location=Dhaka",
      "https://agorasuperstores.com/search?q=" + Buffer.from("soyabean oil", "utf8").toString("base64") + "&location=Dhaka"
    ]
  },
  { key: "meena", name: "Meena Bazar", urls: ["https://meenabazaronline.com/"] },
  { key: "unimart", name: "Unimart", urls: ["https://unimart.online/"] }
];

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// Same variant rules as api/prices.js, plus Unimart 5 kg rice.
// Returns { variant, pack, packQty, unit } or null.
function matchVariant(name, shopName) {
  const n = name.toLowerCase();
  const packMatch = n.match(/(\d+(?:\.\d+)?)\s*(kg|g|gm|ltr|litre|liter|l|ml)\b/);
  let qty = null, unit = null, pack = null;
  if (packMatch) {
    const num = parseFloat(packMatch[1]);
    const u = packMatch[2];
    if (u === "g" || u === "gm") {
      if (num === 500) { qty = 0.5; unit = "kg"; pack = "500 g"; }
      else if (num === 1000) { qty = 1; unit = "kg"; pack = "1 kg"; }
      else return null;
    } else if (u === "kg") { qty = num; unit = "kg"; pack = num + " kg"; }
    else if (u === "ml") {
      if (num === 500) { qty = 0.5; unit = "L"; pack = "500 ml"; }
      else return null;
    } else { qty = num; unit = "L"; pack = num + " L"; }
  } else if (n.includes("loose") || n.includes("per kg")) {
    qty = 1; unit = "kg"; pack = "1 kg";
  } else {
    return null;
  }
  const isMiniket = n.includes("miniket") || n.includes("minicate");
  const isNazir = n.includes("nazir") || n.includes("najir");
  const isMoshur = n.includes("moshur") || n.includes("mosur") || n.includes("mashur");
  const isSoybean = n.includes("soyabean") || n.includes("soybean");
  const isSugar = n.includes("sugar");
  const isSalt = n.includes("salt");
  const isRice = n.includes("rice") || n.includes("chal");
  if (shopName === "Unimart" && isRice && unit === "kg" && qty === 5) {
    return { variant: "unimart-rice-5kg", pack, packQty: qty, unit };
  }
  if (isMiniket && unit === "kg" && qty === 1) return { variant: "miniket-loose-kg", pack, packQty: qty, unit };
  if (isMiniket && unit === "kg" && qty === 5) return { variant: "miniket-5kg", pack, packQty: qty, unit };
  if (isNazir && unit === "kg" && qty === 5) return { variant: "nazirshail-5kg", pack, packQty: qty, unit };
  if (isMoshur && unit === "kg" && qty === 1) return { variant: "moshur-dal-kg", pack, packQty: qty, unit };
  if (isSoybean && unit === "L" && qty === 5) return { variant: "soybean-5L", pack, packQty: qty, unit };
  if (isSoybean && unit === "L" && qty === 1) return { variant: "soybean-1L", pack, packQty: qty, unit };
  if (isSoybean && unit === "L" && qty === 2) return { variant: "soybean-2L", pack, packQty: qty, unit };
  if (isSugar && unit === "kg" && qty === 1) return { variant: "sugar-1kg", pack, packQty: qty, unit };
  if (isSalt && unit === "kg" && qty === 1) return { variant: "salt-1kg", pack, packQty: qty, unit };
  return null;
}

// Extract (name, price, was) candidates from a loaded page, structured data
// only. Returns [] when the page has no structured price data.
async function extractFromPage(page) {
  return page.evaluate(() => {
    const out = [];
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    // Strategy 1: JSON-LD Product offers.
    document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
      try {
        const data = JSON.parse(el.textContent || "null");
        const list = Array.isArray(data) ? data : [data];
        list.forEach((d) => {
          if (!d || d["@type"] !== "Product" || !d.offers) return;
          const offers = Array.isArray(d.offers) ? d.offers : [d.offers];
          offers.forEach((o) => {
            const p = parseFloat(o.price);
            if (p > 0 && p < 100000) {
              out.push({ name: clean(d.name), price: p, was: null });
            }
          });
        });
      } catch (e) { /* malformed JSON-LD is ignored, not guessed around */ }
    });
    // Strategy 2: elements carrying a data-price attribute (Agora's markup
    // and several other shops). The product name is the card's own text:
    // title/subtext where present, otherwise the card text up to the price.
    document.querySelectorAll("[data-price]").forEach((el) => {
      const p = parseFloat(el.getAttribute("data-price"));
      if (!(p > 0) || p >= 100000) return;
      let card = el.closest("[class*=card], [class*=product], li, div");
      let name = "";
      if (card) {
        const title = card.querySelector('[class*=title], [class*=name]');
        const sub = card.querySelector('[class*=subtext], [class*=subtitle]');
        name = clean((title ? title.textContent : "") + " " + (sub ? sub.textContent : ""));
        if (!name) name = clean(card.textContent).slice(0, 200);
      }
      if (name) out.push({ name, price: p, was: null });
    });
    return out;
  });
}

async function scrapeShop(browser, shop) {
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();
  const found = [];
  try {
    for (const url of shop.urls) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        // Let client-side shops render. Unimart's area gate: try Gulshan-2.
        if (shop.key === "unimart") {
          try {
            const gate = page.locator("text=/Gulshan-2/i").first();
            if (await gate.count()) {
              await gate.click({ timeout: 5000 }).catch(() => {});
              await page.waitForTimeout(3000);
            }
          } catch (e) { /* gate not clickable: extraction below decides */ }
        }
        await page.waitForTimeout(3000);
        const candidates = await extractFromPage(page);
        for (const c of candidates) {
          const mv = matchVariant(c.name, shop.name);
          if (!mv) continue;
          found.push({
            shop: shop.name,
            variant: mv.variant,
            product: cleanText(c.name.replace(/\s*\d+(?:\.\d+)?\s*(kg|g|gm|ltr|litre|liter|l|ml)\b.*$/i, "")) || c.name,
            pack: mv.pack,
            packQty: mv.packQty,
            unit: mv.unit,
            price: c.price,
            was: c.was,
            ...(shop.key === "unimart" ? { tag: "Gulshan-2 only" } : {})
          });
        }
      } catch (e) {
        // One failed URL must not kill the shop: other URLs still try.
        console.error(`[${shop.key}] ${url} failed: ${e.message}`);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
  // Dedupe on variant + pack + product.
  const seen = new Set();
  const items = found.filter((it) => {
    const k = it.variant + "|" + it.pack + "|" + it.product.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return items;
}

async function main() {
  const { chromium } = require("playwright");
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
  } catch (e) { /* first run: no previous file, nothing to keep */ }
  const scannedAt = new Date().toISOString();
  const browser = await chromium.launch({ headless: true });
  const shops = {};
  try {
    for (const shop of SHOPS) {
      const checkedAt = new Date().toISOString();
      let items = [];
      try {
        items = await scrapeShop(browser, shop);
      } catch (e) {
        console.error(`[${shop.key}] scrape failed: ${e.message}`);
      }
      if (items.length > 0) {
        shops[shop.key] = { ok: true, checkedAt, items, source: "scraper" };
        console.log(`[${shop.key}] ok, ${items.length} items`);
      } else if (previous && previous.shops && previous.shops[shop.key] && previous.shops[shop.key].ok) {
        // Keep the previous verified entry, with its original checkedAt, so
        // the board shows an honest old timestamp instead of a guessed price.
        shops[shop.key] = previous.shops[shop.key];
        console.log(`[${shop.key}] failed, kept previous entry`);
      } else {
        shops[shop.key] = { ok: false, checkedAt, items: [], reason: "no structured price data found on the page" };
        console.log(`[${shop.key}] failed, no previous entry`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const anyOk = Object.values(shops).some((s) => s.ok && s.items.length > 0);
  const out = { live: anyOk, scannedAt, shops };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${OUT_PATH} (live=${anyOk})`);
}

main().catch((e) => {
  console.error("scraper failed to write output:", e.message);
  process.exit(1);
});
