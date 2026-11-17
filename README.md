# Roof Takeoff

A one-page tool for roof and attic takeoffs. Live at https://roof-takeoff-ten.vercel.app.

- **From photos:** measure pitch from a gable photo and trace roof sections on an overhead photo.
- **By address:** Google's Solar API finds the building and every roof face (pitch, direction, area).
  Google's aerial photo shows the roof outline.
- **`GET /api/takeoff`:** one call that returns the roof outline, each face's plan shape, the roof edges
  (ridge, hip, valley, eave, rake, step, break) and the attic floor area (roof outline minus the overhang,
  without low-slope parts such as porches). The Koala field app calls it server to server.
  **[CONTRACT.md](CONTRACT.md) is the agreed API contract.** Read it before changing anything it describes.

Plain Node (ES modules), no framework, no build step. `index.html` is the whole page. `api/*.js` are Vercel
serverless functions. `lib/google.js` makes every call to Google on the server, so the API key never
reaches the browser.

## Files

| Path | What it is |
|---|---|
| `index.html` | The page (one inline script; reads the aerial photo with geotiff@2.1.3 from a CDN) |
| `api/lookup.js` | Address or map pin → building and roof faces |
| `api/layers.js` | Asks Google for the aerial photo and rooftop mask; returns file ids |
| `api/geotiff.js` | Downloads one of those files by id (adds the key on the server) |
| `api/satellite.js` | Regular satellite picture, the fallback when there is no aerial photo |
| `api/takeoff.js` | The full takeoff (see CONTRACT.md) |
| `lib/google.js` | Google calls, access check, error messages |
| `lib/takeoff.js` | Roof geometry: pure functions, no I/O |
| `lib/raster.js` | Reads Google's GeoTIFF files for `lib/takeoff.js` |
| `dev-server.js`, `dev/` | Local dev server and the mock Google (never deployed) |
| `test/` | `node --test` tests (never deployed) |

## Settings (environment variables)

| Name | Needed | What it does |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | yes | Server-side Google key. Turn on **Geocoding API**, **Solar API** and **Maps Static API** for it. |
| `ACCESS_CODE` | no | When set, every `/api/*` call needs the `x-access-code` header (the page asks for the code once per device). Each lookup costs money, so set this for a crew-only tool. |
| `PARTNER_KEY` | no | Lets the Koala server through with the `x-partner-key` header when `ACCESS_CODE` is set. On its own it locks nothing. |

Set them in the Vercel project settings, then redeploy. For local work put them in a `.env` file
(`KEY=value` lines; it is git-ignored and never deployed).

## Run it locally

Needs Node 20 or later.

```sh
npm install
npm run mock    # synthetic houses, no key, no network: http://localhost:8787
npm run dev     # real Google, with the key from .env: http://localhost:8787
npm test        # geometry and endpoint tests against the mock
```

`PORT=3000 npm run mock` picks another port.

### Mock addresses (`npm run mock`)

| Address | What it shows |
|---|---|
| `1 Gable Ln` | Gable, 40 × 30 ft at 6/12, 1 ft overhang. A shed and a tree next door are ignored. |
| `2 Hip Rd` | Hip roof, 50 × 30 ft at 6/12, turned 25°. |
| `3 Cross Gable Ct` | L-shaped cross gable with two valleys, a low-slope (1/12) front porch against the house wall, and a chimney. |
| `4 Low Detail Dr` | Lower-detail imagery whose surface heights fail to load, plus a flat carport with no pitch data: the degraded path. |
| anything with `404` | Google can't find the address. |
| anything with `no roof` | The address lands on an empty field: no roof data. |
| any other address | Finds `3 Cross Gable Ct`. |

The analytic truth for each mock house (areas, edge lengths, attic floor) is in comments at the top of
`dev/houses.js`. The mock serves real GeoTIFFs (color photo, rooftop mask, surface heights, UTM zone 18N)
and a generated satellite picture, so the page and `/api/takeoff` run the same code as with Google.

## Deploying

Vercel deploys the folder as is (no build step). `vercel.json` gives `/api/takeoff` up to 60 seconds.
`.vercelignore` keeps `.env*`, `dev/`, `dev-server.js`, `test/` and this README out of the deployment.
