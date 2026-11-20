-- =============================================================================
-- Crew load list: clear direction from the estimator and the office to the crew, and what to load
-- at the shop (the crew app's Load list, app/crew/LoadList.tsx, built by lib/jobs/loadList.ts).
--
--   * jobs.crew_notes: notes for the crew that the office adds after the job is booked (the signed
--     estimate is locked, so its own notes can no longer change). Owner and office edit it through
--     the jobs_staff policy; at most 2,000 characters. Each change is in the audit log.
--   * crew_job_view: the same columns in the same order, plus two at the end:
--       estimate_crew_notes  the estimator's "Notes for the crew" (estimates.client_doc->>'crewNotes',
--                            live: never printed on the customer's quote)
--       job_crew_notes       jobs.crew_notes
--     Crews never see a price, so each line of both goes through crew_text_without_prices, as the
--     scope's words do. CREATE OR REPLACE only appends columns, so the view keeps its grants and its
--     security_barrier, and the code already running reads it unchanged.
--   * app_settings.load_list: {"always_bring": [...]}, the equipment every crew loads for every job,
--     owner-edited on the Pricing page (audited like every setting). Seeded with a short generic
--     list, only when absent. Crews may read this one key, as they read blower_door.
--
-- Additive and idempotent: running it twice changes nothing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The office's notes for the crew
-- -----------------------------------------------------------------------------
alter table jobs add column if not exists crew_notes text;
alter table jobs drop constraint if exists jobs_crew_notes_length;
alter table jobs add constraint jobs_crew_notes_length check (crew_notes is null or char_length(crew_notes) <= 2000);
comment on column jobs.crew_notes is
  'Notes for the crew from the office, added after booking (the crew app shows them with the estimator''s). Never on the customer''s quote.';

-- Who changed the notes, and to what (jobs has no row audit of its own).
create or replace function tg_job_crew_notes_audit() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.crew_notes is distinct from old.crew_notes then
    perform log_event('job.crew_notes', 'jobs', new.id::text, jsonb_build_object('crew_notes', new.crew_notes));
  end if;
  return new;
end $$;
drop trigger if exists jobs_crew_notes_audit on jobs;
create trigger jobs_crew_notes_audit after update of crew_notes on jobs
for each row execute function tg_job_crew_notes_audit();

-- -----------------------------------------------------------------------------
-- Notes as a crew reads them: every line through crew_text_without_prices (the accuracy migration),
-- so a price typed into a note never reaches a crew, and the line breaks the writer typed stay.
-- Null when nothing is left.
-- -----------------------------------------------------------------------------
create or replace function crew_notes_without_prices(t text) returns text
language sql immutable set search_path = public as $fn$
  select nullif(btrim(array_to_string(array(
           select crew_text_without_prices(l.line)
             from regexp_split_to_table(replace(t, E'\r', ''), E'\n') with ordinality l(line, i)
            order by l.i), E'\n'), E' \n\t'), '')
$fn$;
grant execute on function crew_notes_without_prices(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- crew_job_view: the accuracy migration's definition, word for word, with the two notes appended.
-- -----------------------------------------------------------------------------
create or replace view crew_job_view with (security_barrier = true) as
with signed as (
  select j.id, j.status, j.scheduled_start, j.scheduled_days, j.crew_id, j.started_at, j.completed_at, j.estimate_id,
         j.crew_notes,
         q.signed_tier, q.snapshot,
         (select o from jsonb_array_elements(coalesce(q.snapshot->'options', '[]')) o
           where o->>'tier' = q.signed_tier::text limit 1) as opt
    from jobs j
    join quotes q on q.id = j.quote_id
   where has_role('owner', 'office')
      or (has_role('crew') and exists (select 1 from crew_members cm where cm.crew_id = j.crew_id and cm.profile_id = auth.uid()))
), signed_areas as (
  select s.id as job_id, (sa.v->>'id')::uuid as area_id, sa.v->>'name' as area_name,
         (sa.v->>'jobType')::job_type_code as job_type, (sa.v->>'sqft')::numeric as sqft,
         (sa.v->>'accessLevel')::access_code as access_level, sa.i::int as ord
    from signed s, jsonb_array_elements(s.snapshot->'input'->'areas') with ordinality sa(v, i)
   where jsonb_typeof(s.snapshot->'input'->'areas') = 'array'
  union all
  select s.id, a.id, a.name, a.job_type, a.sqft, a.access_level, a.sort_order
    from signed s join estimate_areas a on a.estimate_id = s.estimate_id
   where jsonb_typeof(s.snapshot->'input'->'areas') is distinct from 'array'
)
select s.id as job_id, s.status, s.scheduled_start, s.scheduled_days, s.crew_id, s.started_at, s.completed_at,
       p.street, p.city, p.zip, p.lat, p.lng,
       c.first_name, c.last_name, c.phone,
       sa.area_id, sa.area_name, sa.job_type, sa.sqft, a.current_r, a.target_r,
       sa.access_level, a.removal_needed, a.prep_notes, a.hazards, a.hazard_disposition, sa.ord as area_sort,
       s.signed_tier,
       (select jsonb_agg(jsonb_build_object('product', l.v->>'product', 'kind', l.v->>'kind', 'description', crew_text_without_prices(l.v->>'description'),
                                            'qty', (l.v->>'qty')::numeric, 'unit', l.v->>'unit',
                                            'hours', (l.v->>'hours')::numeric) order by l.i)
          from jsonb_array_elements(coalesce(s.opt->'lines', '[]')) with ordinality l(v, i)
         where l.v->>'areaId' = sa.area_id::text and l.v->>'kind' in ('material', 'labor', 'removal')) as scope,
       crew_notes_without_prices(case when jsonb_typeof(e.client_doc->'crewNotes') = 'string' then e.client_doc->>'crewNotes' end) as estimate_crew_notes,
       crew_notes_without_prices(s.crew_notes) as job_crew_notes
from signed s
join estimates e            on e.id = s.estimate_id
join properties p           on p.id = e.property_id
join customers c            on c.id = e.customer_id
join signed_areas sa        on sa.job_id = s.id
left join estimate_areas a  on a.id = sa.area_id;

-- -----------------------------------------------------------------------------
-- What every crew loads for every job (owner-edited on Pricing), and who may read it
-- -----------------------------------------------------------------------------
insert into app_settings (key, value, description) values
  ('load_list', $json${
    "always_bring": [
      "Insulation blower and hoses",
      "Ladders",
      "Respirators and safety glasses",
      "Tarps and drop cloths",
      "Utility knives and tape measure"
    ]
  }$json$::jsonb, 'Load list: what every crew brings to every job (Pricing page)')
on conflict (key) do nothing;

-- Crews read no setting but blower_door and this one (the others carry margins and costs).
drop policy if exists app_settings_crew_load_list on app_settings;
create policy app_settings_crew_load_list on app_settings for select
  using (key = 'load_list' and has_role('crew'));
