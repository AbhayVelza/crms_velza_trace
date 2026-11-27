-- Step 4 — print a before/after report (read-only). Run as velza_owner while schema src is still there:
--   psql "$TARGET_URL" -f migration/04_report.sql > out/migration_report.txt
\pset footer off
\echo '== Row counts: Supabase (src) vs AWS (public)'
SELECT t AS table_name, s AS supabase, a AS aws, CASE WHEN s = a THEN 'OK' ELSE 'DIFF' END AS check
  FROM (VALUES
    ('partners',     (SELECT count(*) FROM src.partners),     (SELECT count(*) FROM public.partners)),
    ('users',        (SELECT count(*) FROM src.users),        (SELECT count(*) FROM public.users)),
    ('batches',      (SELECT count(*) FROM src.batches),      (SELECT count(*) FROM public.batches)),
    ('print_orders', (SELECT count(*) FROM src.print_orders), (SELECT count(*) FROM public.print_orders)),
    ('containers',   (SELECT count(*) FROM src.containers),   (SELECT count(*) FROM public.containers)),
    ('codes',        (SELECT count(*) FROM src.codes),        (SELECT count(*) FROM public.codes)),
    ('code_history', (SELECT count(*) FROM src.code_history), (SELECT count(*) FROM public.code_history))
  ) v(t, s, a);

\echo '== Option C: how the pack rows were stored'
SELECT CASE WHEN code_type = 'LOT' THEN 'case/tray rows (own state)'
            WHEN status IS NULL     THEN 'packs inheriting from a sealed case/tray'
            ELSE 'packs with own state (opened lot, or differed from lot)' END AS kind,
       count(*) AS rows
  FROM public.codes GROUP BY 1 ORDER BY 1;

\echo '== Packs kept with own state although their lot is sealed (review these: state differed from the lot in Supabase)'
SELECT p.code, p.status, p.location_id, l.status AS lot_status, l.location_id AS lot_location
  FROM public.codes p JOIN public.codes l ON l.code = p.lot_code
 WHERE p.code_type = 'PACK' AND p.status IS NOT NULL
   AND NOT (l.status = 'OPENED' OR (l.status = 'RECALLED' AND l.status_before_recall = 'OPENED'))
 ORDER BY p.code LIMIT 50;

\echo '== Event ids that were not UUIDs in Supabase (given a fixed uuid made from the old id)'
SELECT count(*) AS non_uuid_event_ids FROM src.code_history
 WHERE event_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

\echo '== History by monthly partition'
SELECT tableoid::regclass AS partition, count(*) AS rows, min(event_time), max(event_time)
  FROM public.code_history GROUP BY 1 ORDER BY 1;

\echo '== Stock now (lots + loose packs), top 20'
SELECT * FROM public.stock_current ORDER BY units DESC LIMIT 20;

\echo '== Stock: Supabase vs AWS per place, status, lot type and flavour (03 stops on any DIFF; listed here for the record)'
WITH src_stock AS (
       SELECT code_type, location_id, status, lot_type, flavour, count(*)::bigint AS n FROM src.codes GROUP BY 1, 2, 3, 4, 5),
     aws_stock AS (
       -- the v11 summary counts every code by its effective state (decision Q7), as Supabase's rows do
       SELECT code_type, location_id, status, lot_type, flavour, sum(units)::bigint AS n
         FROM public.stock_current
        GROUP BY 1, 2, 3, 4, 5)
SELECT code_type, location_id, status, lot_type, flavour, s.n AS supabase, a.n AS aws,
       CASE WHEN s.n IS NOT DISTINCT FROM a.n THEN 'OK' ELSE 'DIFF' END AS check
  FROM src_stock s FULL JOIN aws_stock a USING (code_type, location_id, status, lot_type, flavour)
 ORDER BY code_type, location_id, status, lot_type, flavour;

\echo '== Damage reports created'
SELECT count(*) AS damage_reports FROM public.damage_reports;

\echo '== Table sizes'
SELECT table_name, parts, approx_rows, data, indexes FROM public.db_table_sizes LIMIT 10;

\echo '== Health'
SELECT * FROM public.db_health;
