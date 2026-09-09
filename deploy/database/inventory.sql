\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;
CREATE TEMP TABLE migration_inventory (schema_name text, table_name text, row_count bigint, content_fingerprint text);
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','drizzle','pgboss') ORDER BY 1,2 LOOP
    EXECUTE format('INSERT INTO migration_inventory SELECT %L,%L,count(*),md5(coalesce(string_agg(h,'''' ORDER BY h),'''')) FROM (SELECT md5(row_to_json(x)::text) h FROM %I.%I x) hashed',t.schemaname,t.tablename,t.schemaname,t.tablename);
  END LOOP;
END $$;
SELECT row_to_json(i) FROM migration_inventory i ORDER BY schema_name,table_name;
SELECT json_build_object('sequence_schema',schemaname,'sequence',sequencename,'last_value',last_value) FROM pg_sequences WHERE schemaname IN ('public','drizzle','pgboss') ORDER BY 1::text;
ROLLBACK;
