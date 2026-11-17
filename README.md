# Roof Takeoff

The roof takeoff engine behind the **Koala field app's Roof lookup**. The Roof Takeoff page is retired: roof
lookups, the attic floor, roof edges, materials and the printable report now live in Koala
(https://koala-estimator-indol.vercel.app/field/roof, sign-in required). This repo keeps the `/api/*` endpoints
that Koala's server calls, at https://roof-takeoff-ten.vercel.app.

- **`GET /api/takeoff`:** one call that returns the roof outline, each face's plan shape, the roof edges (ridge, hip,
  valley, eave, rake, step, headwall, break) and the attic floor (the building's footprint minus the overhang,
  without porch and flat-addition roofs, with the wall run and the roof deck over the attic floor).
  **[CONTRACT.md](CONTRACT.md) (v1.2) is the agreed API contract.** Read it before changing anything it describes.
- **`GET /api/satellite`:** the regular satellite picture of a spot, for showing which building was found.
- **The home page** (`index.html`) is now a short notice with a button to Koala's Roof lookup. Old links
  (`?address=...`, or `?lat=..&lng=..` for a map pin) open Koala's Roof lookup for the same address after one
  second (a pin goes over as `lat,lng`, which `/api/takeoff` measures as a map pin, not a typed address), with the
  button as a fallback. The notice calls no `/api` endpoint, so it never runs a paid lookup, and it loads no scripts
  from elsewhere. It also clears what the old page kept in the browser (its access code, recent addresses and last
  result).

Plain Node (ES modules), no framework, no build step. `api/*.js` are Vercel serverless functions. `lib/google.js`
makes every call to Google on the server, so the API key never leaves it.

## Files

| Path | What it is |
|---|---|
| `index.html` | The retired page: a notice that sends people and old links to Koala (one small inline script, no `/api` calls) |
| `api/takeoff.js` | The full takeoff (see CONTRACT.md). Koala calls it. |
| `api/satellite.js` | Regular satellite picture of a spot. Koala calls it. |
| `api/geotiff.js` | Downloads one of Google's aerial-data files by id (adds the key on the server), for `photo.rgb` |
| `lib/google.js` | Google calls, access check, error messages |
| `lib/takeoff.js` | Roof geometry: pure functions, no I/O |
| `lib/raster.js` | Reads Google's GeoTIFF files for `lib/takeoff.js` |
| `dev-server.js`, `dev/` | Local dev server and the mock Google (never deployed) |
| `test/` | `node --test` tests of the API and geometry, and the e2e of the notice page (never deployed) |

## Settings (environment variables)

| Name | Needed | What it does |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | yes | Server-side Google key. Turn on **Geocoding API**, **Solar API** and **Maps Static API** for it. |
| `PARTNER_KEY` | yes | The shared key Koala's server sends in the `x-partner-key` header (Koala's `ROOF_TAKEOFF_KEY`). When set, every `/api/*` call needs it: Koala is the only client and each lookup costs money, so the old crew access code and calls with no key are refused (401). |
| `ACCESS_CODE` | no | Only for local work without `PARTNER_KEY`: then every `/api/*` call needs the `x-access-code` header. Ignored when `PARTNER_KEY` is set; it can be removed from the Vercel settings. |

Values are trimmed, so a key saved with a trailing newline still works. Set them in the Vercel project settings, then redeploy. For local work put them in a `.env` file
(`KEY=value` lines; it is git-ignored and never deployed).

## Run it locally

Needs Node 20 or later.

```sh
npm install
npm run mock    # synthetic houses, no key, no network: http://localhost:8787 (the API; / is the notice)
npm run dev     # real Google, with the key from .env: http://localhost:8787
npm test        # geometry and endpoint tests against the mock (node --test)
npm run e2e     # the notice page in Chromium (needs Playwright installed)
```

`npm test` checks `lib/takeoff.js` against the mock houses' known answers and calls every endpoint through the
mock, including the auth rules. Koala's own tests use exact `/api/takeoff` answers from this mock, so run both
when the contract changes.

`npm run e2e` starts its own mock dev server on a free port and stands in for the Koala site (nothing reaches the
real Koala, Google or Google Fonts). It checks the notice: the title, the line, the button to Koala's Roof lookup,
that old `?address=` and `?lat=&lng=` links forward with the address encoded and only after one second (and that a
forwarded pin is measured as a pin), that blank or broken links just show the button, that Back doesn't bounce to
Koala again, that the page makes no `/api` call and loads no script, that the old page's saved data is cleared, and
the layout at 320, 375 and 1280 px in light and dark (no sideways scroll, a 56 px button). It also checks that the
same dev server still answers `/api/takeoff` and `/api/satellite`. Screenshots go to a temp folder; `SHOTS=dir` keeps
them elsewhere, and `CHROMIUM=/path/to/chrome` picks the browser.

`PORT=3000 npm run mock` picks another port. Try the API by hand:
`curl 'http://localhost:8787/api/takeoff?address=7%20Cape%20Dormer%20Way'` (add `-H 'x-partner-key: ...'` when
`PARTNER_KEY` is set).

### Mock addresses (`npm run mock`)

| Address | What it shows |
|---|---|
| `1 Gable Ln` | Gable, 40 × 30 ft at 6/12, 1 ft overhang. A shed and a tree next door are ignored. |
| `2 Hip Rd` | Hip roof, 50 × 30 ft at 6/12, turned 25°. |
| `3 Cross Gable Ct` | L-shaped cross gable with two valleys, a low-slope (1/12) front porch against the house wall (headwall), and a chimney. |
| `4 Low Detail Dr` | Lower-detail imagery whose surface heights fail to load, plus a flat carport with no pitch data: the degraded path and `attic.unmatchedM2` ("Parts with no roof data"). |
| `5 Twin Ave` | One half of a twin. The other half's roof touches it in Google's mask but isn't Google's building: the outline is cut at the party wall (`sharedWallM`), with a warning. |
| `6 Flat Roof Plaza` | Commercial building, every face at 1/4 in per ft, with a lower loading bay: nothing is left out of the attic by default, with a "mostly flat" warning. |
| `7 Cape Dormer Way` | 12/12 Cape with a 1.5/12 shed dormer (stays in the attic), an attached 3/12 garage (marked lower, stays in) and a 1/12 porch (left out). Steps at the dormer cheeks and the garage, headwalls under the dormer front and the porch. |
| `8 Main Row` | Middle building of an attached commercial row whose Google box reaches 4 ft into each neighbour: the outline is 1.28 × the building, so the attic floor uses Google's building area with the edge length scaled, and warns. |
| anything with `404` | Google can't find the address. |
| anything with `no roof` | The address lands on an empty field: no roof data. |
| any other address | Finds `3 Cross Gable Ct`. |

The analytic truth for each mock house (areas, edge lengths, attic floor) is in comments at the top of
`dev/houses.js`. The mock serves real GeoTIFFs (color photo, rooftop mask, surface heights, UTM zone 18N)
and a generated satellite picture, so `/api/takeoff` and `/api/satellite` run the same code as with Google. Its surface
heights round off ridges, hips and valleys the way Google's do on real roofs (a band along each steep ridge fits
neither face; eaves and walls stay sharp); `renderLayers({ smooth: false })` gives ideal planes for tests.

## How the takeoff is measured (`lib/takeoff.js`)

- **Outline:** the blob of Google's rooftop mask under the building's faces, cut 0.5 m past Google's building
  box so a twin or rowhouse doesn't take in the neighbour's roof. The cut is `attic.sharedWallM` (no overhang,
  no edges along it). Courtyards are outlined too and count in the perimeter.
- **Attic floor area:** Google's building area (exactly this building's own roof pixels), with the outline's
  edge length and shared wall. If the outline is more than 10% off Google's area (a loose box on a row), those
  lengths are scaled by √(Google's area / outline area) and a warning says so. The outline is drawn as traced.
- **Faces:** each Solar face is a plane; its height is the densest band of the surface heights over the face's
  whole Solar box, so a tree or dormer at Google's center doesn't lose it. A roof pixel goes to the plane that
  fits its height best, if the surface there also has that plane's slope. Google's heights round off every
  ridge, hip and valley, so a band along each fits no face: the faces grow across it (nearest face, up to 1.5 m)
  and meet in the middle, so a ridge is measured once. They don't grow up walls or into a roof part with no
  face of its own, which keeps its own edges.
- **Edges:** where two faces meet with no height jump: ridge, hip, valley or pitch break. Where a lower roof
  meets a higher one, the lower face gets step (sloped side) or headwall (level top) and the higher face keeps
  its eave or rake. Outer sides check the outside roof height first (a wall with no face is step/headwall).
- **Default face choices:** low-slope faces more than 1 m under the main roof are left out (porches, flat
  additions); a low-slope dormer up on the roof stays in; faces more than 1.5 m under it are marked `lower`
  (garage, porch or addition) but stay in; a mostly flat building leaves nothing out and gets a warning.

## The old page

Until November 2026 `index.html` was the whole Roof Takeoff tool (address lookup with the attic floor and roof
edges on the aerial photo, measuring from photos, materials, recent lookups, a printable report). All of it moved
into Koala's Roof lookup, so Koala is the one app the crew uses and the only client of this API. The old page is in
the git history (the commit before "Retire the Roof Takeoff page") if anything needs checking against it.

## Deploying

Vercel deploys the folder as is (no build step). `vercel.json` gives `/api/takeoff` up to 60 seconds.
`.vercelignore` keeps `.env*`, `dev/`, `dev-server.js`, `test/` and this README out of the deployment.
