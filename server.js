const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

async function getBrowser() {
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/catalog', async (req, res) => {
  const { make, vin } = req.query;
  if (!vin) return res.status(400).json({ error: 'vin gerekli' });

  let browser, page;
  try {
    browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    await page.setDefaultNavigationTimeout(30000);

    const catalogUrl = make
      ? `https://partsouq.com/en/catalog/genuine/car?c=${encodeURIComponent(make)}&vin=${encodeURIComponent(vin)}`
      : `https://partsouq.com/en/catalog/genuine/car?vin=${encodeURIComponent(vin)}`;

    await page.goto(catalogUrl, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 4000));

    const currentUrl = page.url();

    const data = await page.evaluate(() => {
      const vehicleInfo = {};
      document.querySelectorAll('table tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          const k = cells[0].innerText.trim().toLowerCase();
          const v = cells[1].innerText.trim();
          if (!v || v === '-') return;
          if (k.includes('brand')) vehicleInfo.make = v;
          if (k.includes('name') && !k.includes('catalog')) vehicleInfo.model = v;
          if (k.includes('model year') || k === 'year') vehicleInfo.year = v;
          if (k.includes('engine no')) vehicleInfo.engine = v;
        }
      });

      const h1 = document.querySelector('h1, .catalog-title');
      if (h1) vehicleInfo.title = h1.innerText.trim();

      const groups = [];
      const seen = new Set();
      const groupNames = ['ENGINE','TRANSMISSION','CHASSIS','BODY','TRIM','ELECTRICAL'];

      document.querySelectorAll('a').forEach(a => {
        const href = a.href || '';
        const text = a.innerText.trim().toUpperCase();
        if (!href.includes('partsouq.com')) return;
        for (const g of groupNames) {
          if ((text === g || href.includes('cname='+g)) && !seen.has(g) && href.includes('vehicle')) {
            seen.add(g);
            groups.push({ name: g, url: href });
            break;
          }
        }
      });

      return { vehicleInfo, groups };
    });

    await browser.close();
    res.json({ vin, catalogUrl: currentUrl, vehicle: data.vehicleInfo, groups: data.groups, scrapedAt: new Date().toISOString() });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Catalog error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`PartsLand API: http://localhost:${PORT}`));
