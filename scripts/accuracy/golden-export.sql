-- Golden set export: the live estimates, read-only. Run with SELECT rights only (the Supabase SQL
-- tool, or psql on a read replica). Never run anything but these SELECTs against production.
--
-- It returns one row: `doc` (text), the whole export as one JSON document, plus its md5 and
-- counts, so the copy on disk can be checked against the database (scripts/accuracy/make-live-golden.ts
-- recomputes the same md5 and counts). The export holds only what pricing and the quote checks need:
-- no customer, no property, no estimator, no notes or prep notes, no quote text. Reasons typed by
-- the estimator are reduced to "given" or "" (the engine only needs to know there is one). Area
-- names stay (they are the room names on the quote, such as "Attic"). Keep the export OUT of git:
-- it lives in the scratchpad's accuracy/golden/ folder.
--
-- Query 1 of 2: the estimates. Query 2 of 2 (the pricing rows) is scripts/accuracy/bundle-rows.sql.
with est as (
  select e.id, e.status, e.selected_tier, e.drive_minutes_est, e.crew_id, e.model_total_price,
         e.created_at, e.updated_at, e.pricing_snapshot_hash, e.client_doc
    from estimates e
),
doc as (
  select jsonb_build_object(
    'id', est.id,
    'status', est.status,
    'selectedTier', est.selected_tier,
    'driveMinutesEst', est.drive_minutes_est,
    'crewId', est.crew_id,
    'modelTotalPrice', est.model_total_price,
    'createdAt', est.created_at,
    'updatedAt', est.updated_at,
    'bundleHash', est.pricing_snapshot_hash,
    -- The phone's draft, cut down to the pricing input.
    'draft', jsonb_build_object(
      'status', est.client_doc->'status',
      'selectedTier', est.client_doc->'selectedTier',
      'crewId', est.client_doc->'crewId',
      'driveMinutesOneWay', est.client_doc->'driveMinutesOneWay',
      'areas', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', a->'id', 'name', a->'name', 'jobType', a->'jobType', 'sqft', a->'sqft',
                 'currentR', a->'currentR', 'targetR', a->'targetR', 'existingMaterial', a->'existingMaterial',
                 'existingDepthIn', a->'existingDepthIn', 'depthIn', a->'depthIn', 'accessLevel', a->'accessLevel',
                 'removalNeeded', a->'removalNeeded', 'prepNotes', null) order by ord)
          from jsonb_array_elements(est.client_doc->'areas') with ordinality as x(a, ord)), '[]'::jsonb),
      'overrides', coalesce((
        select jsonb_object_agg(k, jsonb_build_object('price', v->'price',
                 'reason', case when coalesce(v->>'reason', '') <> '' then 'given' else '' end))
          from jsonb_each(coalesce(est.client_doc->'overrides', '{}'::jsonb)) as o(k, v)), '{}'::jsonb),
      'lineOverrides', coalesce((
        select jsonb_object_agg(k, jsonb_build_object('qty', v->'qty', 'hours', v->'hours', 'tier', v->'tier',
                 'reason', case when coalesce(v->>'reason', '') <> '' then 'given' else '' end))
          from jsonb_each(coalesce(est.client_doc->'lineOverrides', '{}'::jsonb)) as l(k, v)), '{}'::jsonb)
    ),
    -- What the server stored for each option.
    'options', coalesce((
      select jsonb_agg(jsonb_build_object('tier', o.tier, 'label', o.label, 'price', o.price,
               'modelPrice', o.model_price, 'isOverridden', o.is_overridden) order by o.tier)
        from estimate_options o where o.estimate_id = est.id), '[]'::jsonb),
    -- Every quote sent: its dates and the prices the customer was shown (snapshot.document,
    -- written by app/api/quotes/route.ts). No names, addresses or quote text.
    'quotes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'version', q.version, 'status', q.status, 'sentAt', q.sent_at, 'expiresAt', q.expires_at,
               'signedAt', q.signed_at, 'signedTier', q.signed_tier, 'signedPrice', q.signed_price,
               'bundleHash', q.snapshot->'bundleHash',
               'quoteNumber', q.snapshot->'document'->'quoteNumber', 'issuedAt', q.snapshot->'document'->'issuedAt',
               'validUntil', q.snapshot->'document'->'validUntil', 'recommendedTier', q.snapshot->'document'->'recommendedTier',
               -- The price of each option the customer was shown (tier -> price).
               'prices', coalesce((
                 select jsonb_object_agg(so->>'tier', so->'price')
                   from jsonb_array_elements(q.snapshot->'document'->'options') as y(so)), '{}'::jsonb))
             order by q.version)
        from quotes q where q.estimate_id = est.id), '[]'::jsonb)
  ) as e
  from est
),
golden as (
  select jsonb_build_object('estimates', coalesce(jsonb_agg(e order by e->>'id'), '[]'::jsonb))::text as doc from doc
)
select doc,
       md5(doc) as md5,
       length(doc) as chars,
       (select count(*) from estimates) as estimates,
       (select count(*) from quotes) as quotes,
       (select count(*) from estimate_options) as options,
       (select count(*) from estimate_areas) as areas
  from golden;
