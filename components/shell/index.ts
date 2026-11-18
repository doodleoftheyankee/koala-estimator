// The staff app shell. Layouts import StaffShell from '@/components/shell/StaffShell' (server
// only); pages and client screens import from here. How a page plugs in is written at the top of
// StaffShell.tsx.
export { AppShell, useHideTabBar, useInShell } from './AppShell';
export { PageHeader } from './PageHeader';
export { ShellLink, useShellOnline } from './parts';
export type { ShellOrg, ShellProfile } from './parts';
