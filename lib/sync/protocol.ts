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
}
