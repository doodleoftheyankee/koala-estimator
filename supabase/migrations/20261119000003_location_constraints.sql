-- =============================================================================
-- Multi-location, part 3 of 5: "one per database" becomes "one per store".
--
-- Two stores can each have a "Crew A", their own tier menu, their own code minimums, their own
-- default material per product, and each store has exactly one active pricing set, win model and
-- lead-score model, and one weekly report per week.
--
-- app_settings: the key becomes (location_id, key). Code that predates stores saves settings with
-- "on conflict (key)", so a unique index on key alone stays until the cleanup migration; it also
-- means a second store can only be created after that cleanup (create_location() says so).
-- =============================================================================

alter table app_settings drop constraint app_settings_pkey;
alter table app_settings add primary key (location_id, key);
create unique index app_settings_key_compat on app_settings (key);

alter table crews drop constraint crews_name_key;
create unique index crews_location_name_key on crews (location_id, name);

alter table labor_roles drop constraint labor_roles_name_key;
create unique index labor_roles_location_name_key on labor_roles (location_id, name);

alter table lead_sources drop constraint lead_sources_name_key;
create unique index lead_sources_location_name_key on lead_sources (location_id, name);

alter table tier_templates drop constraint tier_templates_job_type_tier_key;
create unique index tier_templates_location_job_type_tier_key on tier_templates (location_id, job_type, tier);

alter table code_requirements drop constraint code_requirements_job_type_assembly_code_edition_key;
create unique index code_requirements_location_key on code_requirements (location_id, job_type, assembly, code_edition);

drop index materials_one_default_per_product;
create unique index materials_one_default_per_product on materials (location_id, product_id) where is_default and active;

drop index coefficient_sets_one_active;
create unique index coefficient_sets_one_active on coefficient_sets (location_id) where status = 'active';

drop index win_models_one_active;
create unique index win_models_one_active on win_models (location_id) where is_active;

drop index lead_score_models_one_active;
create unique index lead_score_models_one_active on lead_score_models (location_id) where is_active;

alter table weekly_reports drop constraint weekly_reports_week_start_key;
create unique index weekly_reports_location_week_key on weekly_reports (location_id, week_start);

-- Lists the office reads most, by store.
create index estimates_location_status_idx on estimates (location_id, status, created_at desc);
create index jobs_location_date_idx on jobs (location_id, scheduled_start);
create index quotes_location_status_idx on quotes (location_id, status, sent_at desc);
create index audit_log_location_at_idx on audit_log (location_id, at desc);
