-- Runs after the migrations. The API roles' grants come from the default privileges set in
-- tests/sql/00_supabase_stub.sql when each object is created, as on production, so a migration's
-- revoke holds here as it does there (review B database-B5); nothing is granted again here.
-- The audit log stays append-only through its trigger (the init migration revokes the rest).
revoke insert, update, delete on audit_log from authenticated;
