// Wire format of POST /api/sync and GET /api/estimates, shared by server and client.

export type SyncResponse =
  | { status: 'applied'; rowVersion: number; bundleHash: string; repriced: boolean }
  | { status: 'conflict' | 'locked'; rowVersion: number; serverDoc: unknown }
  | { status: 'invalid' | 'error'; error: string };

export interface RemoteEstimate {
  id: string;
  status: string;
  rowVersion: number;
  updatedAt: string;
  doc: unknown;
  /**
   * The list's headline price, as the office list has it (lib/office/estimates.ts headlinePrice:
   * the signed price, else the recommended option's): the phone's row shows it (release review C
   * FLOW-2). Null when the estimate has no price; absent from an older server.
   */
  headline?: { price: number; tier: 'good' | 'better' | 'best' | null } | null;
}
