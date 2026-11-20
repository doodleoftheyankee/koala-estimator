import 'server-only';
// The words a server action answers when it refuses the person (review B flow-B10). While Koala's
// database or sign-in service does not answer, the session cannot be read: the person is not "not
// allowed", Koala is just not there, and nothing was saved (L36). Otherwise the action's own words.
import { getSessionState } from './auth';
import { UNREACHABLE_NOT_SAVED } from './sessionState';

export async function actionRefusal(notAllowed: string): Promise<string> {
  const s = await getSessionState();
  return s.state === 'unreachable' ? UNREACHABLE_NOT_SAVED : notAllowed;
}
