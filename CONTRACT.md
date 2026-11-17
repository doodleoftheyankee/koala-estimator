# Roof Takeoff API contract (v1)

Shared by the Roof Takeoff site (this repo) and the Koala field app, which calls it server-to-server.
All lengths are meters and all areas square meters on the wire. Clients convert to feet.

## Auth

Every `/api/*` handler calls `requireAccess(req)`:

1. If `PARTNER_KEY` is set and the `x-partner-key` header equals it (constant-time compare), the call is allowed.
   The Koala server sends this header.
2. Else if an `x-partner-key` header was sent (wrong, or `PARTNER_KEY` is unset): allowed only if `ACCESS_CODE` is
   set and `x-access-code` matches it; otherwise 401 "The partner key doesn't match.", so a misconfigured Koala key
   shows up at once instead of when the site is locked.
3. Else if `ACCESS_CODE` is set, the `x-access-code` header must equal it (constant-time compare), or 401.
4. Else (no `ACCESS_CODE` set) the call is allowed, as today. `PARTNER_KEY` on its own does not lock the tool;
   it only lets the Koala server past an `ACCESS_CODE`.
- A header of a different length is a mismatch. Env values and headers are trimmed before comparing.

## GET /api/takeoff

Query: `address` (trimmed, at most 200 characters) **or** `lat` + `lng`. Optional `overhangIn` (number, 0 to 36, default 12).

One call does the whole job: geocode (address only) → Solar `buildingInsights:findClosest` →
Solar `dataLayers:get` (view `IMAGERY_LAYERS`) → downloads the mask and DSM GeoTIFFs on the server →
measures the outline, each face's plan shape, the roof edges, and the attic floor.
The RGB photo is **not** downloaded by the server; its file id is returned so the browser can fetch it
through `/api/geotiff?id=`.

If the data layers, the mask or the DSM fail, the response is still `200` with the
`buildingInsights` numbers, `outline: null` and/or `faces: []`, `edges: []`, and a plain-English line in `warnings`.
Geocode or `buildingInsights` failures are errors (`{ error }` with the status from `lib/google.js`).

Response 200:

```jsonc
{
  "version": 1,
  "place": { "address": "100 W Main St, Newark, DE 19716, USA" /* null for a pin */, "lat": 39.68, "lng": -75.75, "precision": "ROOFTOP" /* or RANGE_INTERPOLATED, GEOMETRIC_CENTER, APPROXIMATE, PIN */ },
  "building": {
    "center": { "lat": 0, "lng": 0 }, "box": { "sw": { "lat": 0, "lng": 0 }, "ne": { "lat": 0, "lng": 0 } },
    "quality": "HIGH" /* MEDIUM | LOW */, "imageryDate": { "year": 2023, "month": 6, "day": 15 },
    "faces": { "areaM2": 308.1, "groundM2": 252.0 } /* Solar wholeRoofStats: the faces with pitch data */,
    "whole": { "areaM2": 388.7, "groundM2": 300.7 } /* Solar buildingStats: the whole building */
  },
  "segments": [ /* Solar roof faces, biggest ground area first, n = 1.. */
    { "n": 1, "pitchDeg": 26.6, "azimuthDeg": 180.0, "areaM2": 70.7, "groundM2": 49.9,
      "center": { "lat": 0, "lng": 0 }, "box": { "sw": {}, "ne": {} }, "heightM": 12.3,
      "rise": 6.0 /* rise per 12, one decimal */, "lowSlope": false /* rise < 2 */, "lower": false /* v1.1 */ }
  ],
  "photo": { "rgb": "<geotiff id>", "imageryDate": { "year": 2023, "month": 6 }, "pixel": 0.1, "quality": "HIGH" } /* or null */,
  "outline": { /* roof edge seen from above (drip edge), from Google's rooftop mask; null if unavailable */
    "polys": [[{ "lat": 0, "lng": 0 }]], "areaM2": 290.4 /* the traced area, for drawing: the attic uses attic.footprintM2 */, "perimeterM": 74.2
  },
  "faces": [ /* plan shape of each Solar face as found in the surface heights; [] if no DSM */
    { "n": 1, "poly": [{ "lat": 0, "lng": 0 }], "planM2": 48.7 }
  ],
  "edges": [
    { "type": "ridge" /* ridge | hip | valley | eave | rake | step | headwall | break */, "faces": [1, 2] /* one face for outer edges */,
      "lengthM": 12.2 /* true length along the slope */, "planM": 12.2 /* seen from above */,
      "path": [{ "lat": 0, "lng": 0 }, { "lat": 0, "lng": 0 }] }
  ],
  "edgeTotalsM": { "ridge": 0, "hip": 0, "valley": 0, "eave": 0, "rake": 0, "step": 0, "headwall": 0, "break": 0 },
  "attic": {
    "overhangM": 0.3048, "footprintM2": 290.4, "perimeterM": 74.2,
    "perimeterSource": "outline" /* outline | box | none */,
    "excluded": [3, 5] /* low-slope faces left out by default */, "excludedM2": 49.9,
    "floorM2": 241.7, "wallRunM": 71.8
  },
  "warnings": ["Lower-detail imagery. Check the pitch on site."]
}
```

### Edge types

| type | meaning | how it is found |
|---|---|---|
| `ridge` | horizontal line at the top where two faces meet, or the high edge of a shed roof with nothing above | convex, horizontal |
| `hip` | sloped outside corner where two faces meet | convex, sloped |
| `valley` | inside corner where two faces drain together | concave |
| `eave` | low, level outer edge (gutter line) | outer edge across the slope, outside is downhill |
| `rake` | sloped outer edge at a gable end | outer edge running with the slope |
| `step` | a face's SLOPED side meets a wall or a higher roof (step flashing) | height jump > 0.4 m across the line, or outside is higher, and the line runs with the slope |
| `headwall` | a face's LEVEL top edge meets a wall (apron / headwall flashing) | same, but the line is level (across the slope) |
| `break` | pitch change between two faces that slope the same way (gambrel, porch tie-in) | neither convex nor concave, no height jump |

Where a lower roof meets a higher one (height jump), the junction is the LOWER face's `step` or `headwall`,
and the HIGHER face's side along it is still counted as its own `eave` or `rake` (it has drip edge and, for eaves,
starter). Outer sides check the outside height before the rake/eave test, so a side against a higher wall is
`step`/`headwall`, never `rake`/`eave`.

### Attic floor (the same formula everywhere)

`A` = `attic.footprintM2` = `building.whole.groundM2` when present and > 0 (Google's building area is exactly this
building's own roof pixels; on real lookups it matched the traced outline to the hundredth), else the outline area,
else `building.faces.groundM2`.
`P` = `attic.perimeterM`: the outline perimeter including any inner rings such as courtyards, if found; else
estimated from the box's aspect ratio scaled to `A`.
`S` = `attic.sharedWallM`: outline length cut along a neighbour's roof (twins, rowhouses). No overhang there.
When the outline's area differs from `A` by more than 10% (a neighbour's roof or a loose box in the outline), `P` and
`S` are the outline's lengths × √(`A` / outline area), and a warning says "The traced roof edge doesn't match
Google's building size, so the edge length is scaled. Check the attic floor on site." `outline.areaM2` and
`outline.perimeterM` stay as traced. (v1.2; before, `A` was the outline area.)
`d` = overhang in meters.

```
floorAll = max(0, A − (P − S)·d + 4·d²)          // exact for any right-angled outline
floor    = floorAll × max(0, 1 − excludedM2 / A)
wallRun  = max(0, P − S − excludedPerimM − 8·d)   // exterior wall run, inset by the overhang
deck     = floor × (Σ areaM2 / Σ groundM2 over the INCLUDED faces)   // roof deck over the attic floor (spray foam)
```

- `excludedM2` = Σ `groundM2` of the faces left out, plus `attic.unmatchedM2` when the client leaves out
  "parts with no roof data".
- Clients take `A`, `P` and `S` from `attic`, never from `outline`.
- `excludedPerimM` = Σ `attic.perimeterByFaceM[n]` of the faces left out (0 when the server sent no breakdown).
- `deck` is null when no face is included.

### Twins and rowhouses (v1.1)

Google's rooftop mask joins roofs that touch. The outline keeps only mask pixels inside `building.box` grown by
0.5 m (projected to mask pixels). The outline length along that cut is `attic.sharedWallM`, and a warning says
the roof joins a neighbour's. Google's box can be loose on an attached row, so the outline can still take in some
of a neighbour's roof: the attic floor's area is always Google's building, and its lengths are scaled as in
"Attic floor" (v1.2: this replaces the 1.3 × fallback to the box). The outline is still returned and drawn as traced.

### Default face choices (v1.1)

Clients take the defaults from `attic.excluded`; they do not re-derive them from `lowSlope`.
The server's rule: let `steep` = faces with rise ≥ 2 and `mainH` = the ground-area-weighted median plane height of the
steep faces (DSM-fitted heights when the DSM loaded, else `heightM`).

- If steep faces cover less than half the faces' ground area: exclude nothing, and warn
  "Mostly flat or low-slope roof. Check whether there is an attic at all."
- Else exclude each low-slope face whose height is more than 1 m below `mainH` (porches, flat additions). A low-slope
  face at or above that (a shed dormer over the attic) stays in. Without heights, exclude every low-slope face.
- `segments[].lower` = true for any face more than 1.5 m below `mainH` (garage, porch or addition roofs). It is only a
  label hint ("Lower roof: garage, porch or addition?"); it does not exclude the face.

### Extra attic fields (v1.1)

```jsonc
"attic": {
  "overhangM": 0.3048, "footprintM2": 290.4, "perimeterM": 74.2, "perimeterSource": "outline",
  "sharedWallM": 0,                       // outline length cut along a neighbour's roof (scaled with P, see "Attic floor")
  "unmatchedM2": 12.5,                    // max(0, A − Σ segments groundM2): building with no roof data (carports, flat bits)
  "perimeterByFaceM": { "1": 20.1, "2": 18.4 },  // plan length of each face's outer sides on the outline, as measured ({} if no DSM)
  "excluded": [5], "excludedM2": 11.9, "floorM2": 241.7, "wallRunM": 71.8, "deckM2": 270.3
}
```

`segments[]` gains `"lower": false`. `edgeTotalsM` gains `"headwall": 0`. All v1 fields keep their meaning;
`version` stays 1.
