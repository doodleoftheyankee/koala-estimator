// POST /api/quotes: price an estimate on the server, freeze it as a new quote version,
// render + store the PDF, and email the customer a signing link.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { serverEnv } from '@/lib/env';
import { approvalCovers, canSendQuote, priceEstimate, TIERS, type PriceApproval, type PricedOption, type Tier } from '@/lib/pricing';
import { loadApprovals } from '@/lib/quotes/approvals';
import { computeDeviationFlags } from '@/lib/learning/deviation';
import { acknowledgedNote, unacknowledgedFlags } from '@/lib/field/flags';
import { quoteEmail, sendEmail } from '@/lib/quotes/email';
import { buildQuoteDocument, businessYear, counterQuoteNumber, quoteNumberBase, quoteValidUntil } from '@/lib/quotes/model';
import { renderQuotePdf } from '@/lib/quotes/pdf';
import { quoteSettingsForSend } from '@/lib/quotes/profile';
import { loadQuoteSettingRows } from '@/lib/quotes/settings';
import { newQuoteToken, sha256Hex } from '@/lib/quotes/token';
import { authorize } from '@/lib/server/auth';
import { loadPricingBundle } from '@/lib/server/bundle';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { draftSchema, priceableAreas, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  estimateId: z.uuid(),
  expectedPrices: z.partialRecord(z.enum(TIERS), z.number().finite()),
});

interface EstimateRow {
  id: string;
  status: string;
  row_version: number;
  client_doc: unknown;
  estimator_id: string;
}

function pricesOf(options: PricedOption[]): Partial<Record<Tier, number>> {
  return Object.fromEntries(options.map((o) => [o.tier, o.price]));
}

/** True when the phone priced the same tiers at the same prices (within a cent). */
function pricesMatch(expected: Partial<Record<Tier, number>>, actual: Partial<Record<Tier, number>>): boolean {
  for (const t of TIERS) {
    const e = expected[t];
    const a = actual[t];
    if ((e === undefined) !== (a === undefined)) return false;
    if (e !== undefined && a !== undefined && Math.abs(e - a) > 0.01) return false;
  }
  return true;
}

export async function POST(request: Request) {
  const auth = await authorize('owner', 'office', 'estimator');
  if (auth.error) return auth.error;
  const { profile } = auth;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
  }
  const body = bodySchema.safeParse(json);
  if (!body.success) {
    return NextResponse.json({ error: 'Invalid request', issues: z.flattenError(body.error).fieldErrors }, { status: 400 });
  }
  const { estimateId, expectedPrices } = body.data;

  try {
    const supabase = await createClient();
    const { data: estData, error: estErr } = await supabase
      .from('estimates')
      .select('id, status, row_version, client_doc, estimator_id')
      .eq('id', estimateId)
      .maybeSingle();
    if (estErr) throw new Error(`Loading the estimate failed: ${estErr.message}`);
    if (!estData) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    const estimate = estData as EstimateRow;

    if (estimate.status === 'signed') {
      return NextResponse.json({ error: 'This estimate is already signed and cannot be re-quoted.' }, { status: 409 });
    }
    const parsed = draftSchema.safeParse(estimate.client_doc);
    if (!parsed.success) {
      return NextResponse.json({ error: 'The saved estimate is incomplete. Sync it from the phone and try again.' }, { status: 400 });
    }
    const draft: EstimateDraft = parsed.data;

    // No business form to fill in (OD12): nothing about the settings stops a send. What nobody
    // entered prints its default ("Koala Insulation", "Limited lifetime warranty") or is left off,
    // a PLACEHOLDER text counts as not entered, and the consent sentence names the property's state,
    // else the shop address's, else no state (OD14).
    const send = quoteSettingsForSend(await loadQuoteSettingRows(supabase), draft.property.state);

    const customerEmail = draft.customer.email?.trim();
    if (!customerEmail) {
      return NextResponse.json({ error: "Add the customer's email address before sending the quote." }, { status: 400 });
    }

    const bundle = await loadPricingBundle(supabase);
    const priced = priceEstimate(
      { ...toEstimateInput(draft), areas: priceableAreas(draft) },
      bundle.snapshot,
      bundle.coefficientSet,
    );
    const options = priced.options;
    if (options.length === 0) {
      return NextResponse.json({ error: 'Nothing to quote: add at least one complete area.' }, { status: 400 });
    }
    // Every deviation from the model must carry the estimator's note before a customer sees it, and
    // the note must have been written for this deviation (same rule as the phone: lib/field/flags.ts).
    const flags = computeDeviationFlags(priced, { ...toEstimateInput(draft), areas: priceableAreas(draft) }, bundle);
    const unacknowledged = unacknowledgedFlags(flags, draft.deviationAcks);
    if (unacknowledged.length) {
      return NextResponse.json(
        { error: 'unacknowledged_flags', message: 'Explain each change from the model before sending.', flags: unacknowledged },
        { status: 409 },
      );
    }

    const prices = pricesOf(options);
    if (!pricesMatch(expectedPrices, prices)) {
      return NextResponse.json(
        {
          error: 'pricing_changed',
          message: 'Prices changed since this estimate was priced on your phone. Review the new prices and send again.',
          prices,
        },
        { status: 409 },
      );
    }

    // A price beyond what this role may send alone goes out only at the exact price the owner or the
    // office approved for this estimate's option (L34); the approvals used are kept with the quote.
    const approvals = await loadApprovals(supabase, estimateId);
    const policy = canSendQuote(profile.role, options, bundle.snapshot.settings, approvals);
    if (!policy.ok) return NextResponse.json({ error: 'policy', reasons: policy.reasons, problems: policy.problems }, { status: 403 });
    const approvalsUsed = canSendQuote(profile.role, options, bundle.snapshot.settings)
      .problems.map((p) => approvals.find((a) => approvalCovers(a, p)))
      .filter((a): a is PriceApproval => !!a)
      .map((a) => ({ id: a.id, tier: a.tier, price: a.price, modelPrice: a.modelPrice, loadedCost: a.loadedCost ?? null, decidedRole: a.decidedRole }));

    const { settings } = send;
    const admin = createAdminClient();

    const { data: last, error: lastErr } = await admin
      .from('quotes')
      .select('version, quote_number:snapshot->document->>quoteNumber')
      .eq('estimate_id', estimateId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastErr) throw new Error(`Reading quote versions failed: ${lastErr.message}`);
    const previous = last as { version: number; quote_number: string | null } | null;
    const version = (previous?.version ?? 0) + 1;

    const now = new Date();
    // The quote number (OD10): a new version keeps the estimate's number (a number sent before the
    // counter included); a first quote takes the next number of the business year from the counter.
    const base = previous?.quote_number ? quoteNumberBase(previous.quote_number) : null;
    let quoteNumber: string;
    if (base) quoteNumber = `${base}-v${version}`;
    else {
      const year = businessYear(now);
      const { data: counter, error: counterErr } = await admin.rpc('next_quote_number', { year });
      if (counterErr || typeof counter !== 'number') throw new Error(`Numbering the quote failed: ${counterErr?.message ?? 'no number returned'}`);
      // A stored prefix that is not 1 to 6 capitals or digits falls back to KN (OD16), never '-2026-…'.
      quoteNumber = counterQuoteNumber(send.prefix, year, counter, version);
    }

    const { expiresAt } = quoteValidUntil(now, settings.validDays);
    const document = buildQuoteDocument({
      draft,
      options,
      version,
      quoteNumber,
      issuedAt: now,
      validDays: settings.validDays,
      branding: settings.branding,
      estimator: { name: profile.fullName, email: profile.email },
      terms: settings.terms,
      warranty: settings.warranty,
      // The sentence the customer signs under, stored with the quote (L31, OD14).
      consent: send.consent,
    });

    const pdf = await renderQuotePdf(document);
    const pdfPath = `${estimateId}/v${version}.pdf`;
    const upload = await admin.storage.from('quotes').upload(pdfPath, pdf, { contentType: 'application/pdf', upsert: false });
    if (upload.error) throw new Error(`Storing the quote PDF failed: ${upload.error.message}`);

    const { token, hash } = newQuoteToken();

    const { data: inserted, error: insErr } = await admin
      .from('quotes')
      .insert({
        estimate_id: estimateId,
        version,
        status: 'sent',
        pdf_path: pdfPath,
        pdf_sha256: sha256Hex(pdf),
        snapshot: {
          document,
          options,
          bundleHash: bundle.hash,
          coefficientSetId: bundle.coefficientSet.id,
          // Frozen inputs and flags: the learning loop reads these, never the (editable) estimate.
          input: {
            areas: priceableAreas(draft).map((a) => ({ id: a.id, name: a.name, jobType: a.jobType, accessLevel: a.accessLevel, sqft: a.sqft })),
            driveMinutesOneWay: draft.driveMinutesOneWay,
          },
          flags: flags.map((f) => ({ ...f, ackNote: acknowledgedNote(f, draft.deviationAcks) })),
          ...(approvalsUsed.length ? { approvals: approvalsUsed } : {}),
        },
        public_token_hash: hash,
        expires_at: expiresAt.toISOString(),
        sent_at: now.toISOString(),
        sent_by: profile.userId,
        sent_to_email: customerEmail,
        sent_to_phone: draft.customer.phone?.trim() || null,
      })
      .select('id')
      .single();
    if (insErr || !inserted) throw new Error(`Saving the quote failed: ${insErr?.message ?? 'no row returned'}`);
    const quoteId = (inserted as { id: string }).id;

    // Older open versions can no longer be signed.
    const sup = await admin
      .from('quotes')
      .update({ status: 'superseded' })
      .eq('estimate_id', estimateId)
      .in('status', ['sent', 'viewed'])
      .neq('id', quoteId);
    if (sup.error) throw new Error(`Superseding older quotes failed: ${sup.error.message}`);

    const ev = await admin.from('quote_events').insert({ quote_id: quoteId, event: 'sent', meta: { actor_id: profile.userId, version } });
    if (ev.error) throw new Error(`Recording the send failed: ${ev.error.message}`);

    const sentAt = now.toISOString();
    const clientDoc: EstimateDraft = {
      ...draft,
      status: 'sent',
      // The row_version trigger bumps by one on this update.
      rowVersion: estimate.row_version + 1,
      lastQuote: { quoteId, version, sentAt, quoteNumber: document.quoteNumber },
    };
    const { data: updated, error: updErr } = await admin
      .from('estimates')
      .update({ status: 'sent', selected_tier: document.recommendedTier, client_doc: clientDoc })
      .eq('id', estimateId)
      .select('row_version')
      .single();
    if (updErr || !updated) throw new Error(`Updating the estimate failed: ${updErr?.message ?? 'no row returned'}`);
    const rowVersion = (updated as { row_version: number }).row_version;
    clientDoc.rowVersion = rowVersion;

    const url = `${serverEnv.appUrl()}/q/${token}`;
    const mail = quoteEmail(document, url);
    const result = await sendEmail({ to: customerEmail, ...mail });

    return NextResponse.json({ quoteId, version, url, emailed: result.sent, rowVersion, clientDoc });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Sending the quote failed';
    console.error('[quotes] send failed', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
