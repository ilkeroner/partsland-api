# PartsLand API

PartSouq scraper backend — PartsLand uygulaması için.

## Endpoints

- `GET /health` — Sunucu durumu
- `GET /vin/:vin` — VIN ile araç bilgisi + katalog grup linkleri
- `GET /search?make=Hyundai&vin=XXX&q=brake` — Katalog içi arama

## Render.com Deploy

1. Bu repoyu GitHub'a yükle
2. render.com → New → Web Service → repo'yu seç
3. Otomatik deploy olur (render.yaml yapılandırması var)
