-- Stored quote documents, read-only, for the hard-rule-1 check (scripts/accuracy/render-stored.ts):
-- every quote already sent or signed must render exactly as it did before a change.
--
-- Run with SELECT rights only (the Supabase SQL tool, or psql on a read replica). Never run
-- anything but this SELECT against production. The result stays OUT of git: it lives in the
-- scratchpad's accuracy/golden/ folder.
--
-- It returns one row: `doc` (text), every quote as one JSON document, plus its md5 and count, so
-- the copy on disk can be checked against the database. Each quote carries what its pages, PDF and
-- emails render: snapshot.document (options, items, prices, number, dates, branding, terms,
-- warranty), its status, expiry and signing fields, and the consent text stored when it was signed.
-- People are replaced in the query itself, so no customer, property, estimator or signer leaves
-- the database: the customer is "Customer <n>", the address "<n> Sample Street, Sampletown, ST
-- 00000", the estimator "Sample Estimator", the signer "Signer <n>"; an email or phone that was
-- there becomes a placeholder, one that was not stays empty; notes become "Notes from the
-- estimator." when there were any. The franchise's own branding stays (it is the franchise's
-- public business information).
with q as (
  select q.*, dense_rank() over (order by q.estimate_id) as n
    from quotes q
),
docs as (
  select jsonb_build_object(
    'id', q.id,
    'estimateId', q.estimate_id,
    'version', q.version,
    'status', q.status,
    'expiresAt', q.expires_at,
    'sentAt', q.sent_at,
    'firstViewedAt', q.first_viewed_at,
    'signedAt', q.signed_at,
    'signedTier', q.signed_tier,
    'signedPrice', q.signed_price,
    'signerName', case when q.signer_name is null then null else 'Signer ' || q.n end,
    'pdfSha256', q.pdf_sha256,
    'hasSignedPdf', q.signed_pdf_path is not null,
    'consentText', q.esign_audit->>'consentText',
    'document', (q.snapshot->'document')
      || jsonb_build_object(
           'customer', jsonb_build_object(
             'name', 'Customer ' || q.n,
             'email', case when coalesce(q.snapshot->'document'->'customer'->>'email', '') <> '' then 'customer@example.com' end,
             'phone', case when coalesce(q.snapshot->'document'->'customer'->>'phone', '') <> '' then '(555) 010-0100' end),
           'property', jsonb_build_object('line1', q.n || ' Sample Street', 'line2', 'Sampletown, ST 00000'),
           'estimator', jsonb_build_object(
             'name', 'Sample Estimator',
             'email', case when coalesce(q.snapshot->'document'->'estimator'->>'email', '') <> '' then 'estimator@example.com' end),
           'notes', case when coalesce(q.snapshot->'document'->>'notes', '') <> '' then 'Notes from the estimator.' end)
  ) as d
  from q
),
golden as (
  select jsonb_build_object('quotes', coalesce(jsonb_agg(d order by d->>'estimateId', (d->>'version')::int), '[]'::jsonb))::text as doc from docs
)
select doc, md5(doc) as md5, length(doc) as chars, (select count(*) from quotes) as quotes
  from golden;
