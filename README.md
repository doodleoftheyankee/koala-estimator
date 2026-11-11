# AtticScan

A mobile-first web app (PWA) for measuring the **net square footage of attics and crawlspaces**
for insulation estimates. It runs in the phone's browser, installs to the home screen, and
works with no signal once it has loaded once. No login; everything is stored on the phone.

Built with Vite and plain TypeScript (no framework). About 13 KB gzipped.

## What it does

1. **Job**: customer name, address, and a list of spaces.
2. **Space editor**: four space types:
   | Type | Gross area |
   |---|---|
   | Attic Floor | footprint |
   | Roofline | footprint × pitch factor √(1 + (rise/12)²); optional two slopes split by % |
   | Crawl Floor | footprint |
   | Crawl Walls | perimeter × average height (perimeter from the outline, or typed) |

   - **Shapes**: Rectangle, L, T, U (sides labelled A–D on a live drawing), or **Custom**: tap
     the corners on a grid, then type each side's real length. The app solves the polygon
     (see below) and computes the area with the shoelace formula.
   - **Cutouts** use the same shapes, with a quantity (chimney, HVAC platform, stairwell,
     knee-wall void; vents and doors for walls). They are subtracted from gross.
   - **Gross / cutouts / net** stay pinned at the top and update on every keystroke.
3. **Summary**: a table of spaces, net total per type, **Copy summary** text, **Export JSON**
   (uses the share sheet on iPhone), and a **Price in Foam Desk** button per type that opens
   `https://koala-foam-desk.vercel.app?sqft={total}&type={type}`.
   `type` is one of `attic_floor`, `roofline`, `crawl_floor`, `crawl_walls`.
4. **Photos**: up to 6 per space, from the camera or the library. They're shrunk to 2000px
   JPEG on the phone and stored in IndexedDB with thumbnails. AI photo reading is in the
   Koala app (koala-estimator): the photos screen links there.

> AtticScan's measuring tools are built into the Koala estimator's field app, together with AI
> photo reading and quotes. This standalone app keeps working for jobs already saved on a phone.

### Typing lengths

Every length box accepts `24'6"`, `24' 6"`, `24'6`, `24.5`, `294"`, `24ft 6in`, `6 1/2"`,
`10'6 1/2"` and iPhone smart quotes. A bare number is feet. **`24 6` (space between) means
24 ft 6 in**, so you don't have to hunt for the ' and " keys. Pitch accepts `6/12`, `6`
or `7.5:12`.

### How the custom polygon is solved

Taps give each side's **direction**; typed lengths give its **size**. Real tape measurements
rarely close perfectly, so the solver adjusts the lengths as little as possible (weighted
least squares, with "the outline must close" as a constraint):

- Typed sides are held tight (they may move about 1%). The app notes any side it moved more than 1".
- Blank sides take their length from the sketch and absorb most of the gap.
- If a typed side would have to stretch more than 10%, the numbers disagree with the
  drawing, so the app asks you to check them instead of guessing.
- A crossed-over outline gets a warning.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173 (no offline mode in dev)
npm test           # unit tests: parsing, shapes, polygon solver, areas, summary
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/ with the service worker on http://localhost:4173
```

To try it on your phone on the same Wi-Fi, run `npm run dev -- --host` and open the
Network URL. (Installing and offline mode need HTTPS, which is easiest once it's on Vercel.)

## Deploy to Vercel

The repo includes `vercel.json` (Vite preset, `dist/` output, no-cache for `sw.js`, long
cache for hashed assets).

**From GitHub (recommended):**
1. Push this folder to a GitHub repository.
2. In Vercel: **Add New… → Project**, import the repo. If `atticscan/` is a sub-folder of a
   bigger repo, set **Root Directory** to `atticscan`.
3. Leave the detected settings (Framework: Vite, Build: `npm run build`, Output: `dist`) and
   click **Deploy**. Every push to the main branch redeploys.

**From your computer with the CLI:**
```bash
npm i -g vercel
cd atticscan
vercel          # first time: links/creates the project, makes a preview URL
vercel --prod   # production URL
```

No environment variables are needed.

## Install on iPhone

1. Open the Vercel URL in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Open it once while online. After that it works in attics and crawlspaces with no signal.

On Android/Chrome, use the **Install app** prompt or the ⋮ menu → **Install**.

When a new version is deployed, the app shows **"A new version is ready — Update"**. It
doesn't reload by itself mid-measurement.

## Data and storage

- Jobs and photos live in the phone's IndexedDB. Nothing is uploaded anywhere.
- The app asks the browser to keep the data persistent. On iPhone, Safari can still clear
  site data for web apps that **aren't** added to the home screen if they go unused for
  weeks, so install it, and export JSON for anything you need to keep.
- Clearing Safari website data deletes the jobs.

## Project layout

```
index.html               app shell + iOS install meta tags
public/manifest.webmanifest, public/icons/   PWA manifest and icons (npm run icons regenerates)
src/units.ts             feet-inches parsing/formatting, pitch parsing
src/geometry.ts          preset shapes, custom-polygon solver, shoelace area
src/model.ts             job/space data model and gross/cutouts/net per space type
src/summary.ts           summary text, JSON export, Foam Desk link
src/db.ts                IndexedDB (jobs + photos)
src/photos.ts            photo downscaling, thumbnails, link to the Koala app
src/shapeView.ts         shape picker, labelled preview drawing, tap-to-draw grid
src/screens/*.ts         Home, Job, Space editor, Photos, Summary screens
src/main.ts              hash router, service-worker registration, update banner
src/sw-template.js       service worker (vite.config.ts fills in the file list per build)
scripts/e2e.cjs          optional Playwright end-to-end check (see header comment)
```
