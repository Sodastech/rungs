CREATE SCHEMA IF NOT EXISTS "public";
CREATE TABLE IF NOT EXISTS "public"."rungs_schema_migrations" (
  version    integer PRIMARY KEY,
  name       text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Migration 1: init
-- Requests: the engine's state as JSONB, plus the columns the hot queries filter on.
CREATE TABLE "public"."rungs_requests" (
  id            text PRIMARY KEY,
  tenant        text NOT NULL,
  status        text NOT NULL,
  version       integer NOT NULL,
  closed_at     timestamptz,
  next_due_at   timestamptz,
  claimed_until timestamptz,
  state         jsonb NOT NULL
);
CREATE INDEX rungs_requests_due ON "public"."rungs_requests" (next_due_at) WHERE next_due_at IS NOT NULL;
CREATE INDEX rungs_requests_closed ON "public"."rungs_requests" (closed_at) WHERE closed_at IS NOT NULL;

-- Inbox: one row per pending task on an active step, rewritten with the request.
CREATE TABLE "public"."rungs_inbox" (
  task_id      text PRIMARY KEY,
  request_id   text NOT NULL REFERENCES "public"."rungs_requests" (id) ON DELETE CASCADE,
  tenant       text NOT NULL,
  assignee_id  text NOT NULL,
  on_behalf_of text,
  assigned_at  timestamptz NOT NULL,
  view         jsonb NOT NULL
);
CREATE INDEX rungs_inbox_assignee ON "public"."rungs_inbox" (tenant, assignee_id, assigned_at, task_id);
CREATE INDEX rungs_inbox_owner ON "public"."rungs_inbox" (tenant, on_behalf_of, assigned_at, task_id)
  WHERE on_behalf_of IS NOT NULL;
CREATE INDEX rungs_inbox_request ON "public"."rungs_inbox" (request_id);

-- Audit: append-only. Deleting is allowed only inside purgeRequest / purgeRequests (EC-61).
CREATE TABLE "public"."rungs_audit" (
  request_id text NOT NULL,
  seq        integer NOT NULL,
  tenant     text NOT NULL,
  type       text NOT NULL,
  at         timestamptz NOT NULL,
  event      jsonb NOT NULL,
  PRIMARY KEY (request_id, seq)
);
CREATE FUNCTION "public"."rungs_audit_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND current_setting('rungs.purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'Rungs audit events are append-only (%); use purgeRequest or purgeRequests to delete closed requests', TG_OP;
END
$$;
CREATE TRIGGER rungs_audit_append_only BEFORE UPDATE OR DELETE ON "public"."rungs_audit"
  FOR EACH ROW EXECUTE FUNCTION "public"."rungs_audit_append_only"();
CREATE TRIGGER rungs_audit_no_truncate BEFORE TRUNCATE ON "public"."rungs_audit"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."rungs_audit_append_only"();

-- Outbox: domain events until delivered; delivered rows are kept until purgeDispatchedEvents.
CREATE TABLE "public"."rungs_outbox" (
  request_id      text NOT NULL,
  seq             integer NOT NULL,
  event           jsonb NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error      text,
  claimed_until   timestamptz,
  dispatched_at   timestamptz,
  PRIMARY KEY (request_id, seq)
);
CREATE INDEX rungs_outbox_pending ON "public"."rungs_outbox" (next_attempt_at) WHERE dispatched_at IS NULL;
CREATE INDEX rungs_outbox_dispatched ON "public"."rungs_outbox" (dispatched_at) WHERE dispatched_at IS NOT NULL;

CREATE TABLE "public"."rungs_flows" (
  tenant  text NOT NULL,
  key     text NOT NULL,
  version integer NOT NULL,
  flow    jsonb NOT NULL,
  PRIMARY KEY (tenant, key, version)
);

CREATE TABLE "public"."rungs_idempotency" (
  tenant     text NOT NULL,
  key        text NOT NULL,
  request_id text,
  at         timestamptz NOT NULL,
  record     jsonb NOT NULL,
  PRIMARY KEY (tenant, key)
);
CREATE INDEX rungs_idempotency_request ON "public"."rungs_idempotency" (request_id);
CREATE INDEX rungs_idempotency_at ON "public"."rungs_idempotency" (at);

CREATE TABLE "public"."rungs_delegations" (
  id           text PRIMARY KEY,
  tenant       text NOT NULL,
  from_user_id text NOT NULL,
  to_user_id   text NOT NULL,
  rule         jsonb NOT NULL
);
CREATE INDEX rungs_delegations_from ON "public"."rungs_delegations" (from_user_id);
CREATE INDEX rungs_delegations_to ON "public"."rungs_delegations" (to_user_id);

INSERT INTO "public"."rungs_schema_migrations" (version, name) VALUES (1, 'init');
