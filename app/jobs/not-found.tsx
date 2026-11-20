// A job link that leads nowhere (removed, or a mistyped address): inside the app menu, with a
// way back to the jobs list.
import { NotFoundState } from '@/components/shell/StatePages';

export default function JobNotFound() {
  return <NotFoundState title="We can’t find that job" hint="It may have been removed, or the link is wrong." primary={{ href: '/jobs', label: 'Go to Jobs' }} />;
}
