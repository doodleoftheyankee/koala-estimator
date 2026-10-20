// Quote PDF (and signed copy). Rendered on the server with @react-pdf/renderer using the
// built-in Helvetica family only, so rendering never depends on remote fonts.
// react-pdf's <Image> has no alt prop (PDF images are not HTML), so jsx-a11y/alt-text does not apply.
/* eslint-disable jsx-a11y/alt-text */
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import type { Tier } from '@/lib/pricing';
import { financingLine } from './email';
import { DEFAULT_BRAND_COLOR, formatUsd, type QuoteDocument, type QuoteOptionDoc } from './model';

export interface PdfSignature {
  signerName: string;
  signedAt: string; // ISO
  tier: Tier;
  price: number;
  imagePng: Buffer | Uint8Array;
  ip: string | null;
}

const TIER_NAMES: Record<Tier, string> = { good: 'Good', better: 'Better', best: 'Best' };

const s = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 48, paddingHorizontal: 40, fontFamily: 'Helvetica', fontSize: 11, color: '#0f172a' },
  // No lineHeight on the Page: an inherited lineHeight stops react-pdf 4.9 from drawing the
  // render-prop page number in the footer. Multi-line text styles set their own.
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 10, borderBottomWidth: 3 },
  company: { fontFamily: 'Helvetica-Bold', fontSize: 20, lineHeight: 1.2, marginBottom: 2 },
  small: { fontSize: 9.5, color: '#475569' },
  quoteTitle: { fontFamily: 'Helvetica-Bold', fontSize: 16, lineHeight: 1.2, textAlign: 'right', marginBottom: 2 },
  right: { textAlign: 'right' },
  row: { flexDirection: 'row' },
  infoBlock: { flexDirection: 'row', marginTop: 14, marginBottom: 6 },
  infoCol: { flex: 1, paddingRight: 10 },
  label: { fontSize: 8.5, color: '#64748b', textTransform: 'uppercase', marginBottom: 2, fontFamily: 'Helvetica-Bold' },
  bold: { fontFamily: 'Helvetica-Bold' },
  option: { marginTop: 14, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 6 },
  optionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 10, borderTopLeftRadius: 6, borderTopRightRadius: 6 },
  optionTitle: { fontFamily: 'Helvetica-Bold', fontSize: 13, lineHeight: 1.2, color: '#ffffff', flex: 1, paddingRight: 8 },
  badge: { fontFamily: 'Helvetica-Bold', fontSize: 9, backgroundColor: '#ffffff', paddingVertical: 2, paddingHorizontal: 6, borderRadius: 8 },
  optionBody: { paddingHorizontal: 10, paddingVertical: 8 },
  bullet: { flexDirection: 'row', marginBottom: 2 },
  bulletDot: { width: 12 },
  itemHead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#cbd5e1', paddingBottom: 3, marginTop: 8 },
  item: { flexDirection: 'row', paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: '#e2e8f0' },
  colArea: { width: '28%', paddingRight: 6 },
  colDesc: { flex: 1, paddingRight: 6 },
  colPrice: { width: 80, textAlign: 'right' },
  total: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 6 },
  totalText: { fontFamily: 'Helvetica-Bold', fontSize: 14, lineHeight: 1.2 },
  financing: { marginTop: 4, fontSize: 9.5, color: '#334155', textAlign: 'right' },
  section: { marginTop: 16 },
  sectionTitle: { fontFamily: 'Helvetica-Bold', fontSize: 12, marginBottom: 4 },
  para: { fontSize: 10, color: '#334155', lineHeight: 1.4 },
  sigBox: { marginTop: 16, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 6, padding: 12 },
  sigImage: { height: 70, maxWidth: 260, objectFit: 'contain', marginVertical: 6 },
  sigLine: { borderBottomWidth: 1, borderBottomColor: '#0f172a', height: 50, marginBottom: 4, width: 260 },
  footerLeft: { position: 'absolute', bottom: 20, left: 40, fontSize: 8.5, color: '#64748b' },
  footerRight: { position: 'absolute', bottom: 20, left: 40, right: 40, textAlign: 'right', fontSize: 8.5, color: '#64748b' },
});

function formatDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  });
}

function OptionSection({ option, color, recommended }: { option: QuoteOptionDoc; color: string; recommended: boolean }) {
  return (
    <View style={s.option}>
      <View style={[s.optionHead, { backgroundColor: color }]} wrap={false} minPresenceAhead={90}>
        <Text style={s.optionTitle}>
          {TIER_NAMES[option.tier]}: {option.label}
        </Text>
        {recommended ? <Text style={[s.badge, { color }]}>RECOMMENDED</Text> : null}
      </View>
      <View style={s.optionBody}>
        {option.bullets.map((b, i) => (
          <View key={i} style={s.bullet}>
            <Text style={s.bulletDot}>{'•'}</Text>
            <Text style={{ flex: 1 }}>{b}</Text>
          </View>
        ))}
        <View style={s.itemHead} wrap={false}>
          <Text style={[s.colArea, s.label]}>Area</Text>
          <Text style={[s.colDesc, s.label]}>Work</Text>
          <Text style={[s.colPrice, s.label]}>Price</Text>
        </View>
        {option.items.map((it, i) => (
          <View key={i} style={s.item} wrap={false}>
            <Text style={s.colArea}>{it.areaName}</Text>
            <Text style={s.colDesc}>{it.description}</Text>
            <Text style={s.colPrice}>{formatUsd(it.price)}</Text>
          </View>
        ))}
        <View style={s.total} wrap={false}>
          <Text style={s.totalText}>
            {TIER_NAMES[option.tier]} total: {formatUsd(option.price)}
          </Text>
        </View>
        {option.financing ? <Text style={s.financing}>{financingLine(option.financing)}</Text> : null}
      </View>
    </View>
  );
}

function QuotePdf({ doc, signature }: { doc: QuoteDocument; signature?: PdfSignature }) {
  const b = doc.branding;
  const color = /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(b.primaryColor) ? b.primaryColor : DEFAULT_BRAND_COLOR;
  const contact = [b.phone, b.email, b.website].filter((x): x is string => !!x);
  const signedOption = signature ? doc.options.find((o) => o.tier === signature.tier) : undefined;

  return (
    <Document title={`Quote ${doc.quoteNumber}`} author={b.company} subject="Insulation quote" creator={b.company} producer={b.company}>
      <Page size="LETTER" style={s.page}>
        <View style={[s.header, { borderBottomColor: color }]}>
          <View style={{ flex: 1 }}>
            {b.logoUrl ? <Image src={b.logoUrl} style={{ height: 40, maxWidth: 160, objectFit: 'contain', marginBottom: 4 }} /> : null}
            <Text style={[s.company, { color }]}>{b.company}</Text>
            {b.license ? <Text style={s.small}>License {b.license}</Text> : null}
            {contact.length ? <Text style={s.small}>{contact.join('  |  ')}</Text> : null}
          </View>
          <View>
            <Text style={s.quoteTitle}>{signature ? 'Signed Quote' : 'Quote'}</Text>
            <Text style={[s.small, s.right]}>No. {doc.quoteNumber}</Text>
            <Text style={[s.small, s.right]}>Date: {formatDate(doc.issuedAt)}</Text>
            <Text style={[s.small, s.right]}>Valid until: {formatDate(doc.validUntil)}</Text>
          </View>
        </View>

        <View style={s.infoBlock}>
          <View style={s.infoCol}>
            <Text style={s.label}>Prepared for</Text>
            <Text style={s.bold}>{doc.customer.name}</Text>
            {doc.customer.email ? <Text style={s.small}>{doc.customer.email}</Text> : null}
            {doc.customer.phone ? <Text style={s.small}>{doc.customer.phone}</Text> : null}
          </View>
          <View style={s.infoCol}>
            <Text style={s.label}>Property</Text>
            <Text>{doc.property.line1}</Text>
            <Text>{doc.property.line2}</Text>
          </View>
          <View style={s.infoCol}>
            <Text style={s.label}>Your estimator</Text>
            <Text>{doc.estimator.name}</Text>
            {doc.estimator.email ? <Text style={s.small}>{doc.estimator.email}</Text> : null}
          </View>
        </View>

        <Text style={[s.para, { marginTop: 4 }]}>
          {doc.options.length > 1 ? 'Choose the option that fits your home and budget.' : 'Here is the work we recommend.'} Prices include
          materials, labor, and cleanup.
        </Text>

        {doc.options.map((o) => (
          <OptionSection key={o.tier} option={o} color={color} recommended={o.tier === doc.recommendedTier} />
        ))}

        {doc.notes ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Notes</Text>
            <Text style={s.para}>{doc.notes}</Text>
          </View>
        ) : null}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Warranty</Text>
          <Text style={s.para}>{doc.warranty}</Text>
        </View>
        <View style={s.section}>
          <Text style={s.sectionTitle}>Terms</Text>
          <Text style={s.para}>{doc.terms}</Text>
        </View>

        <View style={s.sigBox} wrap={false}>
          <Text style={s.sectionTitle}>Acceptance</Text>
          {signature ? (
            <>
              <Text style={s.para}>
                Option accepted: <Text style={s.bold}>{signedOption ? `${TIER_NAMES[signature.tier]}: ${signedOption.label}` : TIER_NAMES[signature.tier]}</Text>
              </Text>
              <Text style={s.para}>
                Price: <Text style={s.bold}>{formatUsd(signature.price, true)}</Text>
              </Text>
              <Image src={{ data: Buffer.from(signature.imagePng), format: 'png' }} style={s.sigImage} />
              <Text>Signed electronically by {signature.signerName}</Text>
              <Text style={s.small}>Date: {formatDateTime(signature.signedAt)}</Text>
              <Text style={s.small}>IP address: {signature.ip ?? 'not recorded'}</Text>
            </>
          ) : (
            <>
              <View style={s.sigLine} />
              <Text style={s.para}>Sign online at the link in your email.</Text>
            </>
          )}
        </View>

        <Text style={s.footerLeft} fixed>
          {b.company} | {doc.quoteNumber}
        </Text>
        <Text style={s.footerRight} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
      </Page>
    </Document>
  );
}

export async function renderQuotePdf(doc: QuoteDocument, signature?: PdfSignature): Promise<Buffer> {
  return renderToBuffer(<QuotePdf doc={doc} signature={signature} />);
}
