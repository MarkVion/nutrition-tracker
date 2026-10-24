# Nutrition Tracker PWA

Local-first PWA for low-friction nutrition check-ins (3× daily), built per the nutrition-tracker project tickets.

## Run it

It's a static site. Either open `index.html` directly, or serve it:

```bash
cd here
python3 -m http.server 8000
# → http://localhost:8000
```

Deployed to the **`MarkVion/nutrition-tracker`** repo (`main` branch, public). GitHub Pages is **not enabled** — this account's plan doesn't support Pages — so the README URL is the hosting surface, not yet the runtime. The app is fully static and ready to point at any zero-config host (Netlify Drop, Cloudflare Pages, or a local `python3 -m http.server`) the second one of those lands.

## Features (per tickets)

- **Ticket 02** — 3-metric check-in: energy (1–10), hunger/satiety (1–10), brain fog (1–10). Food as text + photo + Quick Add chips.
- **Ticket 03** — IndexedDB storage (date-keyed), localStorage for settings, JSON sync-file export for Hermes.
- **Ticket 04** — GitHub Pages hosting (static, no server).
- **Ticket 05** — Dark zinc `#18181b` + violet→pink gradient, Inter font, 8px radius, emoji chips.
- **Ticket 07** — Zero onboarding: the check-in form is the first thing you see.
- Offline-capable via `sw.js` (network-first, cache-fallback).

## Files

| File | Role |
|---|---|
| `index.html` | App shell (check-in form, history, sync, settings dialog) |
| `styles.css` | Ticket 05 design system |
| `app.js` | IndexedDB helper + core logic (no CDN deps) |
| `sw.js` | Service worker for offline |
| `manifest.json` | Installable PWA manifest |
| `icons/` | 192 + 512 px icons |

## Sync flow

1. Use on the phone (adds to home screen → offline install).
2. Tap **Export JSON** → downloads `nutrition-tracker-data.json`.
3. Upload that file to Hermes.
4. Hermes reads the `days[]` array (schema in ticket 03), correlates with HealthLog, and answers — see ticket 06.

## Privacy

- All data lives in the device's IndexedDB. No server writes, no analytics.
- Photos are down-scaled (≤720 px, JPEG q72) and stored on-device until you export.
- The export file is your source of truth — keep it or delete it; nothing else is sent anywhere.
