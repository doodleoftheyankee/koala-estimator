// A quote link that matches no quote (mistyped, cut off, or made up). The layout above draws the
// franchise header from its settings; this page says what happened and how to reach the office.
import { Compass } from '@/components/daymark/icons';
import { getSettingsBranding } from './data';
import { ClosedState, ContactCard, OfficeContact, ReachUsAction } from './parts';

export default async function QuoteNotFound() {
  const branding = await getSettingsBranding();
  return (
    <ClosedState
      icon={Compass}
      title="We can’t find this quote"
      action={<ReachUsAction branding={branding} estimator={null} />}
      aside={branding ? <ContactCard estimator={null} branding={branding} /> : null}
    >
      <p>The link may be cut short or mistyped. Open it again from your email or text message.</p>
      <p>
        Still stuck? <OfficeContact branding={branding} capital /> and we will send you a new link.
      </p>
    </ClosedState>
  );
}
