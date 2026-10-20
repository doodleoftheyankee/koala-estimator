'use client';
// Sign-out that first drops this device's cached app shells (public/sw.js 'clear-user-data'):
// they embed the signed-in user's profile, and the /field shell shows prices. Unsynced drafts in
// IndexedDB stay, parked until their owner signs back in (lib/offline/db.ts switchUser).
import type { FormEvent } from 'react';

async function clearShells(): Promise<void> {
  const sw = navigator.serviceWorker?.controller;
  if (!sw) return;
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    sw.postMessage('clear-user-data', [channel.port2]);
    setTimeout(resolve, 1500); // never hold up sign-out
  });
}

export function SignOutButton() {
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    await clearShells().catch(() => undefined);
    form.submit();
  }
  return (
    <form action="/auth/signout" method="post" onSubmit={onSubmit}>
      <button className="rounded-lg px-3 py-2 font-medium hover:bg-slate-100">Sign out</button>
    </form>
  );
}
