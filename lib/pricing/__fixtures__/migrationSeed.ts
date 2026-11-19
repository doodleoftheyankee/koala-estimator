// The pricing every new database starts with: the rows supabase/migrations seed, as the server
// maps them (lib/server/snapshot.ts buildSnapshot + makeBundle), with no branding or franchise text.
// On 2026-11-19 these equal the live rows. Unlike ./seed.ts (hand-made test numbers), prices
// computed with this fixture are the prices a quote gets today, so the accuracy examples in
// docs/accuracy/ledger.txt can be checked against it.
//
// If a migration changes a seeded pricing row, regenerate this from a fresh migrated database.
import type { AreaInput, CoefficientSet, EstimateInput, PricingSnapshot } from '../types';

export const seededSnapshot: PricingSnapshot = {
  "settings": {
    "overheadPct": 0.63,
    "targetMarginPct": 0.15,
    "floorMarginPct": 0.05,
    "ceilingMarginPct": 0.3,
    "minimumJobPrice": 1500,
    "priceRounding": 5,
    "productiveHoursPerDay": 7,
    "vehicleCostPerTrip": 45,
    "disposalCostPerSqft": 0.35,
    "estimatorOverrideLimitPct": 0.1,
    "estimatorsSeeCosts": false,
    "deviationThreshold": 0.15,
    "quoteValidDays": 30,
    "financing": {
      "provider": null,
      "apr": 0.0899,
      "termMonths": 120,
      "show": false
    }
  },
  "products": [
    {
      "code": "air_sealing",
      "label": "Air Sealing",
      "unit": "sqft",
      "rPerInch": null,
      "isRBearing": false
    },
    {
      "code": "batts",
      "label": "Fiberglass Batts",
      "unit": "sqft",
      "rPerInch": 3.2,
      "isRBearing": true
    },
    {
      "code": "ccsf",
      "label": "Closed-Cell Spray Foam",
      "unit": "board_ft",
      "rPerInch": 6.5,
      "isRBearing": true
    },
    {
      "code": "cellulose",
      "label": "Blown Cellulose",
      "unit": "bag",
      "rPerInch": 3.6,
      "isRBearing": true
    },
    {
      "code": "fiberglass_blown",
      "label": "Blown Fiberglass",
      "unit": "bag",
      "rPerInch": 2.5,
      "isRBearing": true
    },
    {
      "code": "ocsf",
      "label": "Open-Cell Spray Foam",
      "unit": "board_ft",
      "rPerInch": 3.7,
      "isRBearing": true
    },
    {
      "code": "removal",
      "label": "Old Insulation Removal",
      "unit": "sqft",
      "rPerInch": null,
      "isRBearing": false
    }
  ],
  "materials": [
    {
      "id": "412af8d2-ca0e-48c6-9bd8-8d970c98f883",
      "productCode": "air_sealing",
      "name": "Air sealing materials (per sqft)",
      "unit": "sqft",
      "costPerUnit": 0.1,
      "coverageSqftIn": null
    },
    {
      "id": "ed9ac6c0-3d13-4993-a04b-883899e04f4c",
      "productCode": "batts",
      "name": "Batt (per sqft @ rated R)",
      "unit": "sqft",
      "costPerUnit": 0.75,
      "coverageSqftIn": null
    },
    {
      "id": "30a68d99-a7cb-432b-a319-38591ce81e61",
      "productCode": "ccsf",
      "name": "Closed-cell set (~$2,350/set at full yield, per board ft)",
      "unit": "board_ft",
      "costPerUnit": 0.47,
      "coverageSqftIn": 1
    },
    {
      "id": "d2789015-eee1-4257-b040-d32f7da37d7b",
      "productCode": "cellulose",
      "name": "Cellulose bag (25 lb)",
      "unit": "bag",
      "costPerUnit": 14,
      "coverageSqftIn": 200
    },
    {
      "id": "ab5095e4-cafc-4e31-88a9-bf1f13dc8037",
      "productCode": "fiberglass_blown",
      "name": "Blown fiberglass bag (~28 lb)",
      "unit": "bag",
      "costPerUnit": 38,
      "coverageSqftIn": 450
    },
    {
      "id": "3a2ee144-38cc-44ce-99f9-f2ed8dc025c6",
      "productCode": "ocsf",
      "name": "Open-cell set (~$1,800/set at full yield, per board ft)",
      "unit": "board_ft",
      "costPerUnit": 0.12,
      "coverageSqftIn": 1
    }
  ],
  "crews": [
    {
      "id": "7e3b380e-add7-4514-8af9-a76339142e1d",
      "name": "Crew A",
      "size": 2,
      "blendedHourlyCost": 35
    }
  ],
  "defaultCrewId": "7e3b380e-add7-4514-8af9-a76339142e1d",
  "codeRequirements": [
    {
      "jobType": "attic",
      "minR": 49,
      "edition": "2018 IECC (local)"
    },
    {
      "jobType": "walls",
      "minR": 20,
      "edition": "2018 IECC (local)"
    },
    {
      "jobType": "crawlspace",
      "minR": 19,
      "edition": "2018 IECC (local)"
    },
    {
      "jobType": "rim_joist",
      "minR": 10,
      "edition": "2018 IECC (local)"
    },
    {
      "jobType": "garage",
      "minR": 30,
      "edition": "company default"
    },
    {
      "jobType": "commercial",
      "minR": 30,
      "edition": "company default"
    }
  ],
  "tierTemplates": [
    {
      "jobType": "attic",
      "tier": "best",
      "label": "Remove, Air Seal + Cellulose",
      "primaryProduct": "cellulose",
      "targetR": 60,
      "includeAirSealing": true,
      "includeRemoval": true,
      "bullets": [
        "Old, dirty or damaged insulation removed",
        "Full air sealing before new insulation",
        "Best comfort and efficiency"
      ]
    },
    {
      "jobType": "attic",
      "tier": "better",
      "label": "Air Seal + Blown Cellulose",
      "primaryProduct": "cellulose",
      "targetR": 60,
      "includeAirSealing": true,
      "includeRemoval": false,
      "bullets": [
        "Seals the leaks that drive drafts and high bills",
        "Dense cellulose blocks air movement",
        "Eligible for most utility rebates"
      ]
    },
    {
      "jobType": "attic",
      "tier": "good",
      "label": "Blown Cellulose to Code",
      "primaryProduct": "cellulose",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Brings your attic to current code R-value",
        "Dense cellulose fills gaps and blocks air movement"
      ]
    },
    {
      "jobType": "commercial",
      "tier": "best",
      "label": "Closed-Cell Spray Foam",
      "primaryProduct": "ccsf",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Highest R per inch; moisture and air barrier"
      ]
    },
    {
      "jobType": "commercial",
      "tier": "better",
      "label": "Open-Cell Spray Foam",
      "primaryProduct": "ocsf",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Air seal and insulate in one step"
      ]
    },
    {
      "jobType": "commercial",
      "tier": "good",
      "label": "Blown Fiberglass",
      "primaryProduct": "fiberglass_blown",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Cost-effective code compliance"
      ]
    },
    {
      "jobType": "crawlspace",
      "tier": "best",
      "label": "Closed-Cell Foam + Air Sealing",
      "primaryProduct": "ccsf",
      "targetR": null,
      "includeAirSealing": true,
      "includeRemoval": false,
      "bullets": [
        "Moisture-resistant",
        "Every penetration sealed",
        "Warmest floors"
      ]
    },
    {
      "jobType": "crawlspace",
      "tier": "better",
      "label": "Closed-Cell Spray Foam",
      "primaryProduct": "ccsf",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Moisture-resistant",
        "Seals out drafts and pests"
      ]
    },
    {
      "jobType": "crawlspace",
      "tier": "good",
      "label": "Fiberglass Batts",
      "primaryProduct": "batts",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Insulates the floor above the crawlspace"
      ]
    },
    {
      "jobType": "garage",
      "tier": "best",
      "label": "Open-Cell Spray Foam",
      "primaryProduct": "ocsf",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Seals and insulates; quieter, more comfortable rooms above"
      ]
    },
    {
      "jobType": "garage",
      "tier": "better",
      "label": "Blown Fiberglass",
      "primaryProduct": "fiberglass_blown",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Seamless coverage over living space"
      ]
    },
    {
      "jobType": "garage",
      "tier": "good",
      "label": "Fiberglass Batts",
      "primaryProduct": "batts",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Insulates the garage ceiling or walls"
      ]
    },
    {
      "jobType": "rim_joist",
      "tier": "best",
      "label": "Closed-Cell Spray Foam",
      "primaryProduct": "ccsf",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Air, moisture and thermal barrier in one"
      ]
    },
    {
      "jobType": "rim_joist",
      "tier": "better",
      "label": "Open-Cell Spray Foam",
      "primaryProduct": "ocsf",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Seals the biggest air leak in most basements"
      ]
    },
    {
      "jobType": "rim_joist",
      "tier": "good",
      "label": "Fiberglass Batts",
      "primaryProduct": "batts",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Fills the rim joist bays"
      ]
    },
    {
      "jobType": "walls",
      "tier": "best",
      "label": "Closed-Cell Spray Foam",
      "primaryProduct": "ccsf",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Highest R per inch",
        "Adds wall rigidity and a moisture barrier"
      ]
    },
    {
      "jobType": "walls",
      "tier": "better",
      "label": "Open-Cell Spray Foam",
      "primaryProduct": "ocsf",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Seals and insulates in one step",
        "Excellent sound dampening"
      ]
    },
    {
      "jobType": "walls",
      "tier": "good",
      "label": "Dense-Pack Cellulose",
      "primaryProduct": "cellulose",
      "targetR": null,
      "includeAirSealing": false,
      "includeRemoval": false,
      "bullets": [
        "Installed from outside or inside with minimal disruption",
        "Fills the full cavity"
      ]
    }
  ]
};

export const seededCoefficients: CoefficientSet = {
  "id": "0313ef48-daee-4070-bcb7-d9a7c51546d0",
  "version": 1,
  "coefficients": [
    {
      "kind": "access_mult",
      "product": null,
      "jobType": null,
      "accessLevel": "difficult",
      "value": 1.35
    },
    {
      "kind": "access_mult",
      "product": null,
      "jobType": null,
      "accessLevel": "easy",
      "value": 1
    },
    {
      "kind": "access_mult",
      "product": null,
      "jobType": null,
      "accessLevel": "extreme",
      "value": 1.6
    },
    {
      "kind": "access_mult",
      "product": null,
      "jobType": null,
      "accessLevel": "moderate",
      "value": 1.15
    },
    {
      "kind": "drive_time_factor",
      "product": null,
      "jobType": null,
      "accessLevel": null,
      "value": 1.1
    },
    {
      "kind": "labor_hrs_per_unit",
      "product": "air_sealing",
      "jobType": null,
      "accessLevel": null,
      "value": 0.006
    },
    {
      "kind": "labor_hrs_per_unit",
      "product": "batts",
      "jobType": null,
      "accessLevel": null,
      "value": 0.015
    },
    {
      "kind": "labor_hrs_per_unit",
      "product": "ccsf",
      "jobType": null,
      "accessLevel": null,
      "value": 0.006
    },
    {
      "kind": "labor_hrs_per_unit",
      "product": "cellulose",
      "jobType": null,
      "accessLevel": null,
      "value": 0.15
    },
    {
      "kind": "labor_hrs_per_unit",
      "product": "fiberglass_blown",
      "jobType": null,
      "accessLevel": null,
      "value": 0.15
    },
    {
      "kind": "labor_hrs_per_unit",
      "product": "ocsf",
      "jobType": null,
      "accessLevel": null,
      "value": 0.004
    },
    {
      "kind": "removal_hrs_per_sqft",
      "product": null,
      "jobType": "attic",
      "accessLevel": null,
      "value": 0.02
    },
    {
      "kind": "removal_hrs_per_sqft",
      "product": null,
      "jobType": "crawlspace",
      "accessLevel": null,
      "value": 0.03
    },
    {
      "kind": "removal_hrs_per_sqft",
      "product": null,
      "jobType": null,
      "accessLevel": null,
      "value": 0.025
    },
    {
      "kind": "setup_hours",
      "product": "air_sealing",
      "jobType": null,
      "accessLevel": null,
      "value": 0.5
    },
    {
      "kind": "setup_hours",
      "product": "batts",
      "jobType": null,
      "accessLevel": null,
      "value": 1
    },
    {
      "kind": "setup_hours",
      "product": "ccsf",
      "jobType": null,
      "accessLevel": null,
      "value": 3
    },
    {
      "kind": "setup_hours",
      "product": "cellulose",
      "jobType": null,
      "accessLevel": null,
      "value": 2
    },
    {
      "kind": "setup_hours",
      "product": "fiberglass_blown",
      "jobType": null,
      "accessLevel": null,
      "value": 2
    },
    {
      "kind": "setup_hours",
      "product": "ocsf",
      "jobType": null,
      "accessLevel": null,
      "value": 3
    },
    {
      "kind": "setup_hours",
      "product": "removal",
      "jobType": null,
      "accessLevel": null,
      "value": 1
    },
    {
      "kind": "waste_factor",
      "product": "batts",
      "jobType": null,
      "accessLevel": null,
      "value": 1.05
    },
    {
      "kind": "waste_factor",
      "product": "ccsf",
      "jobType": null,
      "accessLevel": null,
      "value": 1.25
    },
    {
      "kind": "waste_factor",
      "product": "cellulose",
      "jobType": null,
      "accessLevel": null,
      "value": 1.08
    },
    {
      "kind": "waste_factor",
      "product": "fiberglass_blown",
      "jobType": null,
      "accessLevel": null,
      "value": 1.08
    },
    {
      "kind": "waste_factor",
      "product": "ocsf",
      "jobType": null,
      "accessLevel": null,
      "value": 1.25
    }
  ]
};

/** An area as the phone sends it: easy access, nothing in place, no depth, no removal. */
export const seededArea = (overrides: Partial<AreaInput> = {}): AreaInput => ({
  id: 'a1',
  name: 'Attic',
  jobType: 'attic',
  sqft: 1000,
  currentR: 0,
  targetR: null,
  existingMaterial: null,
  existingDepthIn: null,
  depthIn: null,
  accessLevel: 'easy',
  removalNeeded: false,
  prepNotes: null,
  ...overrides,
});

/** An estimate with a 20 minute drive and the default crew. */
export const seededEstimate = (overrides: Partial<EstimateInput> = {}): EstimateInput => ({
  areas: [seededArea()],
  crewId: null,
  driveMinutesOneWay: 20,
  overrides: {},
  ...overrides,
});
