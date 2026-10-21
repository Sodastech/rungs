CREATE SCHEMA IF NOT EXISTS "public";
CREATE TABLE IF NOT EXISTS "public"."rungs_schema_migrations" (
  version    integer PRIMARY KEY,
  name       text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Migration 2: list_queries
-- Columns for rungs.requests() and rungs.blocked(), filled from the stored state.
ALTER TABLE "public"."rungs_requests"
  ADD COLUMN requester_id text,
  ADD COLUMN subject_type text,
  ADD COLUMN subject_id   text,
  ADD COLUMN flow_key     text,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN blocked_at   timestamptz;
UPDATE "public"."rungs_requests" SET
  requester_id = state->>'requesterId',
  subject_type = state->'subject'->>'type',
  subject_id   = state->'subject'->>'id',
  flow_key     = state->>'flowKey',
  submitted_at = (state->>'submittedAt')::timestamptz,
  blocked_at   = CASE WHEN status = 'pending' THEN (
    SELECT (step->>'blockedAt')::timestamptz
    FROM jsonb_array_elements(state->'steps') WITH ORDINALITY AS s(step, position)
    WHERE step->>'status' = 'blocked'
    ORDER BY position DESC
    LIMIT 1
  ) END;
ALTER TABLE "public"."rungs_requests"
  ALTER COLUMN requester_id SET NOT NULL,
  ALTER COLUMN subject_type SET NOT NULL,
  ALTER COLUMN subject_id   SET NOT NULL,
  ALTER COLUMN flow_key     SET NOT NULL,
  ALTER COLUMN submitted_at SET NOT NULL;
CREATE INDEX rungs_requests_list ON "public"."rungs_requests" (tenant, submitted_at DESC, id DESC);
CREATE INDEX rungs_requests_requester ON "public"."rungs_requests" (tenant, requester_id, submitted_at DESC, id DESC);
CREATE INDEX rungs_requests_status ON "public"."rungs_requests" (tenant, status, submitted_at DESC, id DESC);
CREATE INDEX rungs_requests_subject ON "public"."rungs_requests" (tenant, subject_type, subject_id);
CREATE INDEX rungs_requests_blocked ON "public"."rungs_requests" (tenant, blocked_at, id) WHERE blocked_at IS NOT NULL;

-- Inbox rows now carry the request payload.
UPDATE "public"."rungs_inbox" AS i SET view = i.view || jsonb_build_object('payload', r.state->'payload')
FROM "public"."rungs_requests" AS r WHERE r.id = i.request_id;

INSERT INTO "public"."rungs_schema_migrations" (version, name) VALUES (2, 'list_queries');
