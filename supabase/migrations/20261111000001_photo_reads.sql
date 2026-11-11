-- AI photo reading (Phase 3 takeoff, first cut). The field app sends an area's photos to
-- /api/photos/read, which asks the model what it sees and logs every read here: the model, cost,
-- tokens and the findings. A read can happen before the estimate or its area has synced, so the
-- area link is optional and the estimate id is kept as a plain value. The server writes these rows
-- with the service role after checking the user; people can read their own reads and the owner
-- reads all of them (cost tracking, and later the photo_area_bias calibration).

alter table photo_analyses alter column area_id drop not null;
alter table photo_analyses add column if not exists estimate_id uuid;
alter table photo_analyses add column if not exists created_by uuid references profiles(id) on delete set null;
alter table photo_analyses add column if not exists photo_count int;

create index if not exists photo_analyses_created_by_idx on photo_analyses (created_by, created_at desc);
create index if not exists photo_analyses_estimate_idx on photo_analyses (estimate_id);

-- The Phase 0 policies let a user write analyses for areas they can edit and corrections for any
-- analysis id (the check only looked at corrected_by). Both are now written by the server only.
drop policy if exists analyses_rw on photo_analyses;
drop policy if exists corrections_rw on photo_corrections;

drop policy if exists analyses_own_read on photo_analyses;
create policy analyses_own_read on photo_analyses for select
  using (created_by = auth.uid() or has_role('owner'));

-- Corrections are written by the server for the person who made them.
drop policy if exists corrections_own_read on photo_corrections;
create policy corrections_own_read on photo_corrections for select
  using (corrected_by = auth.uid() or has_role('owner'));
