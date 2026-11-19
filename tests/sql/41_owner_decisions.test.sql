-- Review B and the owner decisions of round 2 (docs/accuracy/spec/owner-decisions-2.txt), in the
-- last sections of supabase/migrations/20261119000001_accuracy.sql:
--   OD12/OD13  the seeded company, terms and warranty read "Koala Insulation", terms that name no
--              town and "Limited lifetime warranty", but only where the stored value is still the
--              seed (a value the owner saved is never overwritten), and the seed's PLACEHOLDER
--              descriptions go with them;
-- Each conditional is tested both ways: a database still holding the seed is changed, one where the
-- owner saved a value keeps it, and a second run changes nothing.

\set seed_branding '{"company":"Koala Insulation of Newark","license":null,"phone":null,"primary_color":null,"logo_path":null}'
\set seed_terms 'Quote valid for the period shown. A signed quote authorizes Koala Insulation of Newark to schedule the work. Final price may change only if hidden conditions are found; any change requires your written approval.'
\set new_terms 'Quote valid for the period shown. A signed quote authorizes Koala Insulation to schedule the work. Final price may change only if hidden conditions are found; any change requires your written approval.'

-- ---------------------------------------------------------------------------
-- A new database (every migration ran once, then the earlier test files): no seed is left
-- ---------------------------------------------------------------------------
create temp table od_expect as select :'new_terms'::text as terms;
do $$ begin
  assert (select value->>'company' from app_settings where key = 'branding') = 'Koala Insulation',
    'the seeded company is "Koala Insulation" (OD12)';
  assert (select value - 'company' from app_settings where key = 'branding')
         = '{"license":null,"phone":null,"primary_color":null,"logo_path":null}'::jsonb,
    'the other branding fields are as seeded (license and phone left off the quote)';
  assert (select description from app_settings where key = 'branding') = 'Quote PDF branding',
    'its PLACEHOLDER description is gone';
  assert (select value #>> '{}' from app_settings where key = 'quote_terms') = (select terms from od_expect),
    'the seeded terms name Koala Insulation and no town (OD12)';
  assert (select description from app_settings where key = 'quote_terms') = 'Terms printed on every quote',
    'their PLACEHOLDER description is gone';
  assert (select value #>> '{}' from app_settings where key = 'warranty_text') = 'Limited lifetime warranty',
    'the warranty reads "Limited lifetime warranty" (OD13)';
  assert (select description from app_settings where key = 'warranty_text') = 'Warranty text on the quote PDF',
    'the warranty description is unchanged (it never said PLACEHOLDER)';
  assert (select count(*) from app_settings
           where key in ('branding', 'quote_terms', 'warranty_text')
             and (value::text ~* 'placeholder|newark' or description ~* 'placeholder')) = 0,
    'nothing a quote prints says PLACEHOLDER or Newark';
  assert not exists (select 1 from app_settings where key = 'default_state'),
    'no state is seeded (the consent sentence never needs one: OD14)';
end $$;

-- ---------------------------------------------------------------------------
-- A database still holding the seeds (production today): the migration replaces them
-- ---------------------------------------------------------------------------
update app_settings set value = :'seed_branding'::jsonb, description = 'PLACEHOLDER — PDF branding' where key = 'branding';
update app_settings set value = to_jsonb(:'seed_terms'::text), description = 'Terms printed on every quote — PLACEHOLDER, owner to replace' where key = 'quote_terms';
update app_settings set value = '"Workmanship warranty — PLACEHOLDER, owner to replace."'::jsonb where key = 'warranty_text';
\i supabase/migrations/20261119000001_accuracy.sql
do $$ begin
  assert (select value from app_settings where key = 'branding')
         = '{"company":"Koala Insulation","license":null,"phone":null,"primary_color":null,"logo_path":null}'::jsonb,
    'seed branding: the company becomes "Koala Insulation", nothing else changes';
  assert (select description from app_settings where key = 'branding') = 'Quote PDF branding', 'seed branding: description cleared';
  assert (select value #>> '{}' from app_settings where key = 'quote_terms') = (select terms from od_expect), 'seed terms: neutral terms';
  assert (select description from app_settings where key = 'quote_terms') = 'Terms printed on every quote', 'seed terms: description cleared';
  assert (select value #>> '{}' from app_settings where key = 'warranty_text') = 'Limited lifetime warranty', 'seed warranty: Limited lifetime warranty';
end $$;

-- Running it again changes nothing.
create temp table od_after_first as select key, value, description from app_settings where key in ('branding', 'quote_terms', 'warranty_text');
\i supabase/migrations/20261119000001_accuracy.sql
do $$ begin
  assert (select count(*) from app_settings s join od_after_first f using (key)
           where s.value is distinct from f.value or s.description is distinct from f.description) = 0,
    'a second run changes nothing';
end $$;

-- ---------------------------------------------------------------------------
-- A database where the owner saved values: they are kept, word for word
-- ---------------------------------------------------------------------------
-- The owner kept the seeded company name but added a phone (the value is no longer the seed).
update app_settings set value = '{"company":"Koala Insulation of Newark","license":null,"phone":"(555) 010-0199","primary_color":null,"logo_path":null}'::jsonb,
                        description = 'Quote PDF branding' where key = 'branding';
-- Terms and a warranty the owner wrote.
update app_settings set value = '"Our own terms."'::jsonb, description = 'Terms printed on every quote' where key = 'quote_terms';
update app_settings set value = '"Workmanship warranty: 10 years."'::jsonb where key = 'warranty_text';
create temp table od_owner as select key, value, description from app_settings where key in ('branding', 'quote_terms', 'warranty_text');
\i supabase/migrations/20261119000001_accuracy.sql
do $$ begin
  assert (select value->>'company' || ' / ' || (value->>'phone') from app_settings where key = 'branding')
         = 'Koala Insulation of Newark / (555) 010-0199',
    'a company the owner saved (with a phone) is kept';
  assert (select value #>> '{}' from app_settings where key = 'quote_terms') = 'Our own terms.', 'terms the owner wrote are kept';
  assert (select value #>> '{}' from app_settings where key = 'warranty_text') = 'Workmanship warranty: 10 years.', 'a warranty the owner wrote is kept';
  assert (select count(*) from app_settings s join od_owner o using (key)
           where s.value is distinct from o.value or s.description is distinct from o.description) = 0,
    'no owner value or description changed';
end $$;

-- Only the exact seed is replaced: the seeded terms with one word changed, or the seeded warranty
-- with its PLACEHOLDER still in it but edited, are the owner's.
update app_settings set value = to_jsonb(replace(:'seed_terms'::text, 'Quote valid', 'Quote is valid')) where key = 'quote_terms';
update app_settings set value = '"Workmanship warranty — PLACEHOLDER, owner to replace. Two years."'::jsonb where key = 'warranty_text';
\i supabase/migrations/20261119000001_accuracy.sql
do $$ begin
  assert (select value #>> '{}' from app_settings where key = 'quote_terms') like 'Quote is valid%Koala Insulation of Newark%',
    'edited terms are not the seed: kept';
  assert (select value #>> '{}' from app_settings where key = 'warranty_text') = 'Workmanship warranty — PLACEHOLDER, owner to replace. Two years.',
    'an edited warranty is not the seed: kept (the app still never prints a PLACEHOLDER text: lib/quotes/settings.ts)';
end $$;

-- Put the seeded state back for any file that runs after this one.
update app_settings set value = '{"company":"Koala Insulation","license":null,"phone":null,"primary_color":null,"logo_path":null}'::jsonb,
                        description = 'Quote PDF branding' where key = 'branding';
update app_settings set value = to_jsonb(:'new_terms'::text), description = 'Terms printed on every quote' where key = 'quote_terms';
update app_settings set value = '"Limited lifetime warranty"'::jsonb where key = 'warranty_text';

\echo '  ok'
