// Quote PDF (and signed copy). Rendered on the server with @react-pdf/renderer using the
// built-in Helvetica family only, so rendering never depends on remote fonts.
// react-pdf's <Image> has no alt prop (PDF images are not HTML), so jsx-a11y/alt-text does not apply.
/* eslint-disable jsx-a11y/alt-text */
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import type { Tier } from '@/lib/pricing';
import { calendarDay, formatAuditTime, formatDateLong } from '@/lib/format';
import { financingLine } from './email';
import { DEFAULT_BRAND_COLOR, documentTimeZone, isLegacyDocument, quoteMoney, sentenceMoney, type QuoteDocument, type QuoteOptionDoc } from './model';

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

/** "December 17, 2026" (lib/format.ts, in the document's zone; a stored calendar day reads as that day). */
const formatDate = (iso: string, tz: string): string => formatDateLong(calendarDay(iso), tz);

/**
 * An option with more lines than this may run past one page, so it is allowed to break; any
 * shorter option is kept on one page (L39) when it fits one (KEEP_TOGETHER_MAX_HEIGHT).
 */
export const KEEP_TOGETHER_MAX_LINES = 18;

/** The height a page gives its content: letter (792 pt) less the top and bottom padding. */
export const PAGE_CONTENT_HEIGHT = 792 - 36 - 48;

/**
 * The tallest option kept on one page, in points: a page's content height less a margin for the
 * estimate below. react-pdf cannot place a block kept together that is taller than a page: it
 * squeezes the whole page and the lines print over each other (review A DOC-4).
 */
export const KEEP_TOGETHER_MAX_HEIGHT = 640;

/** Lines a text takes in a column that fits about `perLine` characters (on the high side: words wrap early). */
const linesOf = (text: string, perLine: number) => Math.max(1, Math.ceil(text.length / perLine));

/**
 * About how tall an option block prints, in points, from its text and the styles above, erring
 * high: about 20 characters a line in the Area column, 44 in Work, 78 for a bullet and 46 in the
 * title, at 11 pt (13.2 pt a line; the title 13 pt bold, 15.6 pt a line).
 */
export function estimateOptionHeight(option: Pick<QuoteOptionDoc, 'tier' | 'label' | 'bullets' | 'items' | 'financing'>): number {
  const LINE = 13.2;
  const frame = 14 + 2 + 16; // margin above, border, body padding
  const head = 16 + linesOf(`${TIER_NAMES[option.tier]}: ${option.label}`, 46) * 15.6;
  const bullets = option.bullets.reduce((h, b) => h + linesOf(b, 78) * LINE + 2, 0);
  const itemHead = 8 + 10.2 + 3 + 1;
  const items = option.items.reduce((h, it) => h + Math.max(linesOf(it.areaName, 20), linesOf(it.description, 44)) * LINE + 8.5, 0);
  const total = 6 + 16.8;
  const financing = option.financing ? 4 + 2 * 11.4 : 0;
  return frame + head + bullets + itemHead + items + total + financing;
}

/**
 * One option: its title bar, bullets, lines, total and financing. `keepTogether` (documents sent
 * from the accuracy round on, L39) keeps the whole block on one page, so an option's lines are
 * never split from its title or total; an option too long or too tall for a page still breaks,
 * its title never left alone at the foot of a page.
 */
export function OptionSection({ option, color, recommended, keepTogether = false }: { option: QuoteOptionDoc; color: string; recommended: boolean; keepTogether?: boolean }) {
  const together =
    keepTogether && option.items.length + option.bullets.length <= KEEP_TOGETHER_MAX_LINES && estimateOptionHeight(option) <= KEEP_TOGETHER_MAX_HEIGHT;
  return (
    // No wrap prop at all unless kept together: react-pdf lays out an explicit `wrap={undefined}`
    // differently from none, and a document sent before must lay out exactly as it did (hard rule 1).
    <View style={s.option} {...(together ? { wrap: false } : {})}>
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
            <Text style={s.colPrice}>{quoteMoney(it.price)}</Text>
          </View>
        ))}
        <View style={s.total} wrap={false}>
          <Text style={s.totalText}>
            {TIER_NAMES[option.tier]} total: {quoteMoney(option.price)}
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
  // A quote sent before the accuracy round prints as it did then (hard rule 1).
  const legacy = isLegacyDocument(doc);
  // Its dates and times read in the zone it was sent in (New York for a quote sent before that was kept).
  const tz = documentTimeZone(doc);

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
            <Text style={[s.small, s.right]}>Date: {formatDate(doc.issuedAt, tz)}</Text>
            <Text style={[s.small, s.right]}>Valid until: {formatDate(doc.validUntil, tz)}</Text>
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
          <OptionSection key={o.tier} option={o} color={color} recommended={o.tier === doc.recommendedTier} keepTogether={!legacy} />
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
                Price: <Text style={s.bold}>{sentenceMoney(doc, signature.price)}</Text>
              </Text>
              <Image src={{ data: Buffer.from(signature.imagePng), format: 'png' }} style={s.sigImage} />
              <Text>Signed electronically by {signature.signerName}</Text>
              <Text style={s.small}>Date: {formatAuditTime(signature.signedAt, tz)}</Text>
              <Text style={s.small}>IP address: {signature.ip ?? 'not recorded'}</Text>
            </>
          ) : (
            <>
              <View style={s.sigLine} />
              {/* The link may have been sent by text or by hand when email is not set up (L33). */}
              <Text style={s.para}>{legacy ? 'Sign online at the link in your email.' : 'Sign online at the link we sent you.'}</Text>
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
