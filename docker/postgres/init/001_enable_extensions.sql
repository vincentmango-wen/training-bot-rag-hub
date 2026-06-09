CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  RAISE NOTICE 'PostgreSQL extensions enabled: vector, pgcrypto';
END $$;
