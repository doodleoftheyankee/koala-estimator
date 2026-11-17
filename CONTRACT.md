# Roof Takeoff API contract (v1)

Shared by the Roof Takeoff site (this repo) and the Koala field app, which calls it server-to-server.
All lengths are meters and all areas square meters on the wire. Clients convert to feet.

## Auth

Every `/api/*` handler calls `requireAccess(req)`:

- If `PARTNER_KEY` is set and the `x-partner-key` header equals it (constant-time compare), the call is allowed.
  The Koala server sends this header.
- Else if `ACCESS_CODE` is set, the `x-access-code` header must equal it (constant-time compare), or 401.
- Else (neither set) the call is allowed, as today.

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
      "rise": 6.0 /* rise per 12, one decimal */, "lowSlope": false /* rise < 2 */ }
  ],
  "photo": { "rgb": "<geotiff id>", "imageryDate": { "year": 2023, "month": 6 }, "pixel": 0.1, "quality": "HIGH" } /* or null */,
  "outline": { /* roof edge seen from above (drip edge), from Google's rooftop mask; null if unavailable */
    "polys": [[{ "lat": 0, "lng": 0 }]], "areaM2": 290.4, "perimeterM": 74.2
  },
  "faces": [ /* plan shape of each Solar face as found in the surface heights; [] if no DSM */
    { "n": 1, "poly": [{ "lat": 0, "lng": 0 }], "planM2": 48.7 }
  ],
  "edges": [
    { "type": "ridge" /* ridge | hip | valley | eave | rake | step | break */, "faces": [1, 2] /* one face for outer edges */,
      "lengthM": 12.2 /* true length along the slope */, "planM": 12.2 /* seen from above */,
      "path": [{ "lat": 0, "lng": 0 }, { "lat": 0, "lng": 0 }] }
  ],
  "edgeTotalsM": { "ridge": 0, "hip": 0, "valley": 0, "eave": 0, "rake": 0, "step": 0, "break": 0 },
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
| `step` | a face meets a wall or a higher roof (step or counter flashing) | height jump > 0.4 m across the line, or outside is higher |
| `break` | pitch change between two faces that slope the same way (gambrel, porch tie-in) | neither convex nor concave, no height jump |

### Attic floor (the same formula everywhere)

`A` = footprint (outline area if found, else `building.whole.groundM2`, else `building.faces.groundM2`).
`P` = perimeter (outline perimeter if found, else estimated from the box's aspect ratio scaled to `A`).
`d` = overhang in meters.

```
floorAll = max(0, A − P·d + 4·d²)      // exact for any right-angled outline
floor    = floorAll × max(0, 1 − excludedM2 / A)
wallRun  = max(0, P − 8·d)              // inset perimeter, for exterior wall runs
```

`excluded` defaults to every face with `lowSlope: true` (porches, flat additions: usually no attic).
Clients recompute with their own overhang and face choices using the same formula and `excludedM2` = the sum of
`groundM2` of the faces they leave out.
