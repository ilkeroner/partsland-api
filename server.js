const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Browser instance - yeniden kullan
let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ]
    });
  }
  return browser;
}

// ─────────────────────────────────────────
// GET /health — sunucu sağlık kontrolü
// ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ─────────────────────────────────────────
// GET /vin/:vin — VIN ile araç + grup linkleri
// ─────────────────────────────────────────
app.get('/vin/:vin', async (req, res) => {
  const { vin } = req.params;
  
  if (!vin || vin.length < 5) {
    return res.status(400).json({ error: 'Geçersiz VIN' });
  }

  let page = null;
  try {
    const br = await getBrowser();
    const context = await br.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    page = await context.newPage();

    // PartSouq ana sayfasına git, VIN ile arama yap
    await page.goto('https://partsouq.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Arama kutusuna VIN gir
    await page.waitForSelector('input[name="q"], input[placeholder*="VIN"], input[placeholder*="Part"], .search-input, #search', { timeout: 10000 });
    const searchInput = await page.$('input[name="q"]') || await page.$('input[placeholder*="VIN"]') || await page.$('.search-form input');
    
    if (!searchInput) {
      throw new Error('Arama kutusu bulunamadı');
    }

    await searchInput.fill(vin);
    await page.keyboard.press('Enter');
    
    // Sonuç sayfasını bekle
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const currentUrl = page.url();

    // Eğer direkt katalog sayfasına girdiyse
    if (currentUrl.includes('/catalog/genuine/car') || currentUrl.includes('/catalog/genuine/vehicle')) {
      const result = await extractCatalogData(page, vin);
      await context.close();
      return res.json(result);
    }

    // Arama sonuçları sayfasındaysa - ilk sonuca tıkla
    if (currentUrl.includes('/search') || currentUrl.includes('/catalog')) {
      // İlk araç sonucuna tıkla
      const firstResult = await page.$('.car-item a, .catalog-item a, table tbody tr:first-child a, .vehicle-list a');
      if (firstResult) {
        await firstResult.click();
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);
        const result = await extractCatalogData(page, vin);
        await context.close();
        return res.json(result);
      }
    }

    // Sayfa URL'si ile devam et
    const result = await extractCatalogData(page, vin);
    await context.close();
    return res.json(result);

  } catch (err) {
    if (page) await page.context().close().catch(() => {});
    console.error('VIN scrape error:', err.message);
    res.status(500).json({ error: err.message, vin });
  }
});

// ─────────────────────────────────────────
// Katalog sayfasından araç bilgisi + grup linkleri çıkar
// ─────────────────────────────────────────
async function extractCatalogData(page, vin) {
  const url = page.url();

  // Araç bilgilerini çek
  const vehicleInfo = await page.evaluate(() => {
    const info = {};
    // Breadcrumb veya başlık
    const title = document.querySelector('h1, .catalog-title, .vehicle-title, .page-title');
    if (title) info.title = title.innerText.trim();

    // Detay tablosu
    const rows = document.querySelectorAll('table tr, .vehicle-info tr, .car-details tr');
    rows.forEach(row => {
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2) {
        const key = cells[0].innerText.trim().toLowerCase();
        const val = cells[1].innerText.trim();
        if (key.includes('brand') || key.includes('make')) info.make = val;
        if (key.includes('name') || key.includes('model')) info.model = val;
        if (key.includes('year') || key.includes('model year')) info.year = val;
        if (key.includes('engine')) info.engine = val;
      }
    });

    return info;
  }).catch(() => ({}));

  // Grup linklerini çek (ENGINE, TRANSMISSION vs.)
  const groups = await page.evaluate(() => {
    const links = [];
    // Sol menüdeki kategori linkleri
    const selectors = [
      '.categories-list a',
      '.sidebar a',
      '.category-menu a', 
      'nav a',
      '.groups-list a',
      'a[href*="cname="]',
      'a[href*="cid="]',
      '.left-menu a',
    ];
    
    const seen = new Set();
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(a => {
        const href = a.href;
        const text = a.innerText.trim().toUpperCase();
        if (href && href.includes('partsouq.com') && !seen.has(text) && text.length > 0) {
          // Sadece ana gruplar
          const mainGroups = ['ENGINE','TRANSMISSION','CHASSIS','BODY','TRIM','ELECTRICAL'];
          if (mainGroups.some(g => text.includes(g))) {
            seen.add(text);
            links.push({ name: text, url: href });
          }
        }
      });
      if (links.length > 0) break;
    }
    return links;
  }).catch(() => []);

  // Katalog ana URL'si
  const catalogUrl = url.includes('partsouq.com') ? url : `https://partsouq.com/en/catalog/genuine/car?c=&vin=${vin}`;

  return {
    vin,
    catalogUrl,
    vehicle: vehicleInfo,
    groups,
    scrapedAt: new Date().toISOString()
  };
}

// ─────────────────────────────────────────
// GET /search?make=Hyundai&vin=XXX&q=brake
// Katalog içi arama — ssd parametreli URL döndür
// ─────────────────────────────────────────
app.get('/search', async (req, res) => {
  const { make, vin, q } = req.query;
  if (!make || !vin) return res.status(400).json({ error: 'make ve vin gerekli' });

  let page = null;
  try {
    const br = await getBrowser();
    const context = await br.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    page = await context.newPage();

    // Katalog sayfasını aç
    const catalogUrl = `https://partsouq.com/en/catalog/genuine/car?c=${encodeURIComponent(make)}&vin=${encodeURIComponent(vin)}`;
    await page.goto(catalogUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Eğer parça arama terimi verilmişse, arama kutusuna yaz
    if (q) {
      const searchBox = await page.$('input[name="q"], .catalog-search input, input[placeholder*="search"], input[placeholder*="Search"]');
      if (searchBox) {
        await searchBox.fill(q);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);
      }
    }

    const result = await extractCatalogData(page, vin);
    result.searchQuery = q;
    result.searchUrl = page.url();

    await context.close();
    res.json(result);

  } catch (err) {
    if (page) await page.context().close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// Sunucu başlat
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PartsLand API çalışıyor: http://localhost:${PORT}`);
});

// Kapatma sinyalinde browser'ı temizle
process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
