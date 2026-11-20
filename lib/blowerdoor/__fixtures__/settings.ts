// Test data only: the two programs one franchise works with, as its owner entered them. App code
// never names a program or a dollar amount; each franchise enters its own on the Rebate programs
// page. (Same values as the seed in supabase/migrations/20261120000001_blower_door.sql.)
import type { StoredSettings } from '../settings';

export const SEEDED: StoredSettings = {
  gauge: 'Retrotec Model 5000',
  flow_exponent: 0.65,
  n_factor: 19,
  programs: [
    {
      key: 'home_performance',
      name: 'Energize Delaware Home Performance with ENERGY STAR',
      label: 'Home Performance',
      tiers: [
        { reduction_pct: 20, rebate: 900 },
        { reduction_pct: 30, rebate: 1300 },
        { reduction_pct: 40, rebate: 1800 },
      ],
      cost_cap_pct: 75,
      mech_vent_rebate_cap: 400,
      source: 'Energize Delaware rebate schedule',
      effective_date: '2024-11-01',
      paperwork: [
        "Photo of the gauge showing CFM, before and after, with the customer's name and address visible in the shot",
        'Combustion appliance zone (CAZ) test if the home has combustion appliances',
        'Health and safety inspection',
        'Test Out Form signed by the customer',
      ],
      paperwork_source: 'Participating Contractors Operations Manual (Oct 2025)',
    },
    {
      key: 'assisted',
      name: 'Energize Delaware Assisted Home Performance',
      label: 'Assisted',
      tiers: [
        { reduction_pct: 20, rebate: 1100 },
        { reduction_pct: 30, rebate: 1500 },
        { reduction_pct: 40, rebate: 2000 },
      ],
      cost_cap_pct: 75,
      mech_vent_rebate_cap: 600,
      source: 'Energize Delaware rebate schedule',
      effective_date: '2024-11-01',
      paperwork: [
        "Photo of the gauge showing CFM, before and after, with the customer's name and address visible in the shot",
        'Combustion appliance zone (CAZ) test if the home has combustion appliances',
        'Health and safety inspection',
        'Test Out Form signed by the customer',
      ],
      paperwork_source: 'Participating Contractors Operations Manual (Oct 2025)',
    },
  ],
};
