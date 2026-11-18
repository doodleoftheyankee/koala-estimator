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

/**
 * ETag of a pricing bundle (GET /api/bundle): its pricing hash plus its store and that store's
 * details version, so the phone refetches when either changes or the person switches store.
 */
export function bundleEtag(hash: string, location: { id: string; rowVersion: number } | undefined): string {
  return location ? `"${hash}.${location.id}.${location.rowVersion}"` : `"${hash}"`;
}
