# Roof Takeoff

A one-page tool for roof and attic takeoffs. Live at https://roof-takeoff-ten.vercel.app.

- **From photos:** measure pitch from a gable photo and trace roof sections on an overhead photo.
- **By address:** one call to `/api/takeoff` gives the two numbers a takeoff needs: the **attic floor** (for
  blown-in insulation) and the **sloped roof area** (for roofing), plus the **roof deck over the attic floor**
  (for spray foam under the deck), every roof face and the roof edges (ridge, hip, valley, eave, rake, step,
  headwall, break) drawn on Google's aerial photo.
- **`GET /api/takeoff`:** one call that returns the roof outline, each face's plan shape, the roof edges and
  the attic floor (the building's footprint minus the overhang, without porch and flat-addition roofs, with the wall run
  and the roof deck). The Koala field app calls it server to server.
  **[CONTRACT.md](CONTRACT.md) (v1.2) is the agreed API contract.** Read it before changing anything it describes.

Plain Node (ES modules), no framework, no build step. `index.html` is the whole page. `api/*.js` are Vercel
serverless functions. `lib/google.js` makes every call to Google on the server, so the API key never
reaches the browser.

## Files

| Path | What it is |
|---|---|
| `index.html` | The page (one inline script; reads the aerial photo with geotiff@2.1.3 from a CDN) |
| `api/lookup.js` | Address or map pin → building and roof faces (the page no longer calls it) |
| `api/layers.js` | Asks Google for the aerial photo and rooftop mask; returns file ids (the page no longer calls it) |
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
| `PARTNER_KEY` | no | Lets the Koala server through with the `x-partner-key` header when `ACCESS_CODE` is set. On its own it locks nothing, but a call that sends a partner key that doesn't match is refused (401 "The partner key doesn't match."), so a wrong Koala key shows up at once. |

Values are trimmed, so a key saved with a trailing newline still works. Set them in the Vercel project settings, then redeploy. For local work put them in a `.env` file
(`KEY=value` lines; it is git-ignored and never deployed).

## Run it locally

Needs Node 20 or later.

```sh
npm install
npm run mock    # synthetic houses, no key, no network: http://localhost:8787
npm run dev     # real Google, with the key from .env: http://localhost:8787
npm test        # geometry and endpoint tests against the mock
npm run e2e     # the page in Chromium against the mock (needs Playwright installed)
```

`npm run e2e` starts its own mock servers on free ports, checks every feature of the page (including that no
link, reload or photo tap calls `/api/takeoff` on its own) and saves screenshots of `7 Cape Dormer Way` (375 and
1280 px, light and dark, print) to a temp folder; `SHOTS=dir` keeps them elsewhere.

`PORT=3000 npm run mock` picks another port.

### Mock addresses (`npm run mock`)

| Address | What it shows |
|---|---|
| `1 Gable Ln` | Gable, 40 × 30 ft at 6/12, 1 ft overhang. A shed and a tree next door are ignored. |
| `2 Hip Rd` | Hip roof, 50 × 30 ft at 6/12, turned 25°. |
| `3 Cross Gable Ct` | L-shaped cross gable with two valleys, a low-slope (1/12) front porch against the house wall (headwall), and a chimney. |
| `4 Low Detail Dr` | Lower-detail imagery whose surface heights fail to load, plus a flat carport with no pitch data: the degraded path and the "Parts with no roof data" row. |
| `5 Twin Ave` | One half of a twin. The other half's roof touches it in Google's mask but isn't Google's building: the outline is cut at the party wall (`sharedWallM`), with a warning. |
| `6 Flat Roof Plaza` | Commercial building, every face at 1/4 in per ft, with a lower loading bay: nothing is left out of the attic by default, with a "mostly flat" warning. |
| `7 Cape Dormer Way` | 12/12 Cape with a 1.5/12 shed dormer (stays in the attic), an attached 3/12 garage (marked lower, stays in) and a 1/12 porch (left out). Steps at the dormer cheeks and the garage, headwalls under the dormer front and the porch. |
| `8 Main Row` | Middle building of an attached commercial row whose Google box reaches 4 ft into each neighbour: the outline is 1.28 × the building, so the attic floor uses Google's building area with the edge length scaled, and warns. |
| anything with `404` | Google can't find the address. |
| anything with `no roof` | The address lands on an empty field: no roof data. |
| any other address | Finds `3 Cross Gable Ct`. |

The analytic truth for each mock house (areas, edge lengths, attic floor) is in comments at the top of
`dev/houses.js`. The mock serves real GeoTIFFs (color photo, rooftop mask, surface heights, UTM zone 18N)
and a generated satellite picture, so the page and `/api/takeoff` run the same code as with Google. Its surface
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

## The page

- **Address lookup:** one call to `/api/takeoff`, then the color photo through `/api/geotiff` (the plain
  satellite picture from `/api/satellite` if that fails).
- **Paid lookups only on purpose:** each lookup costs money, so only Look up, a recent lookup, or "Look up the
  roof here (paid)" runs one. Tapping the photo marks a spot and asks first; the result is labelled "Near
  <the old address>". Links (`?address=...` or `?lat=..&lng=..`) fill in the address or mark the pin and wait
  for a tap. The address bar follows each lookup, and a reload or restored tab shows that tab's last result
  again from `sessionStorage` (photo and choices included) without calling the server.
- **Two numbers:** sloped roof area and attic floor, in the lookup panel and in the Roof total card, plus the
  roof deck over the attic floor. The overhang chips (none to 24 in, one setting for the page) and the "Over
  the attic" checkboxes recompute them with the CONTRACT.md formulas. The starting choices are the server's
  (`attic.excluded`). "Parts with no roof data" gets its own row when it is over 5% of the footprint.
- **Warnings:** an amber "Check on site" line under the lookup numbers and in the Roof total; the status turns
  amber. A failed lookup takes the previous house off the screen so its numbers can't be mistaken for the new one.
- **Roof edges:** colored on the photo, totals per type and a materials helper (drip edge, starter strip,
  ridge cap, valley, step flashing, headwall (apron) flashing, rounded up to the next foot).
- **Report:** Print or save PDF (one letter page), Copy summary (plain text), Copy link.
- **Recent lookups:** the last 12, kept in this browser only (`localStorage`). Tapping one runs it again (paid).
- **Phones:** controls are at least 44 px; the faces table keeps both sq ft columns on screen at 375 px.
- **From photos (steps 1 to 3):** plus an "Over the attic" checkbox per section; traced sections over the attic
  keep the overhang along a side they share. The Roof total follows whichever method was used last; the
  "Totals from" switch changes it.

## Deploying

Vercel deploys the folder as is (no build step). `vercel.json` gives `/api/takeoff` up to 60 seconds.
`.vercelignore` keeps `.env*`, `dev/`, `dev-server.js`, `test/` and this README out of the deployment.
