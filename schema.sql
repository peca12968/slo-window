CREATE TABLE IF NOT EXISTS relay_jobs (
    id uuid PRIMARY KEY,
    payload text NOT NULL,
    state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','running','done','dead')),
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
    available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    lease_token uuid,
    lease_until timestamptz,
    result jsonb,
    last_error text,
    CHECK (attempts BETWEEN 0 AND max_attempts),
    CHECK ((lease_token IS NOT NULL) = (state = 'running')),
    CHECK ((lease_until IS NOT NULL) = (state = 'running'))
);
CREATE INDEX IF NOT EXISTS relay_ready ON relay_jobs (available_at, id) WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS relay_running ON relay_jobs (lease_until, id) WHERE state = 'running';
ALTER TABLE relay_jobs ADD COLUMN IF NOT EXISTS request_key text COLLATE "C";
CREATE UNIQUE INDEX IF NOT EXISTS relay_request_key ON relay_jobs (request_key) WHERE request_key IS NOT NULL;
