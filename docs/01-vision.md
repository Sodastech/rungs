# 01 — Vision

## The problem

Almost every internal application eventually needs approvals: expenses, leave, purchase orders,
contracts, access requests. Teams usually start with a `status` column and an `approved_by` field, then
discover the real requirements one incident at a time:

- The approver is on leave and nobody can act.
- The requester is also the approver for their own request.
- The same manager appears in two consecutive steps and must click twice.
- The department head position is vacant, or held by an acting (interim) person.
- An employee changes department while their request is half-approved.
- Two approvers click "approve" at the same moment.
- A request sits untouched for two weeks and nobody notices.

Existing open-source libraries handle the mechanics (levels, steps, audit) reasonably well, but they
expect the host application to answer **"who approves this step?"** — usually as a fixed list of user
IDs or a role. That answer, with its edge cases, is exactly where teams lose weeks and where
AI coding agents produce code that looks right and fails in production.

## The product

**Rungs is an approval engine for TypeScript that treats "who approves" as a first-class problem.**

- A pure, deterministic core engine (MIT) that gets the mechanics right: sequential and parallel steps,
  conditions, delegation, deadlines, escalation, return/resubmit, concurrency, audit.
- Org-aware approver resolution (Pro) built on a small org-graph interface the host implements once:
  managers, chains, department heads, acting holders, vacancies, reorganizations.
- A documented catalog of edge cases, each with a defined behavior and a test. The catalog is both the
  specification and the main marketing asset.

## Who it is for

- Developers building internal tools, back-office systems and B2B SaaS in TypeScript
  (Next.js, NestJS, Express, Fastify, Remix).
- Small teams and solo founders who need approvals now and cannot afford a BPMN platform.
- Teams using AI coding agents who want a reliable foundation the agent builds on instead of
  reinventing approval logic each time.

## Who it is not for

- Teams that need full BPMN modeling, long-running service orchestration, or a hosted workflow
  platform (Camunda, Temporal and similar are the better fit).
- Non-developers looking for a no-code approval app.

## Positioning in one sentence

*"Approval workflows that know your org chart — the edge cases already handled and tested."*

## Principles

1. **Correct before clever.** Every behavior is defined, documented and tested.
2. **Bring your own everything.** Rungs never owns users, roles, departments or notifications.
   The host supplies them through small interfaces.
3. **Embeddable.** A library, not a server. No required infrastructure beyond a database.
4. **Deterministic core.** Same input, same output. Easy to test, easy to reason about.
5. **Agent-friendly.** Clear types, explicit errors and a Claude Code skill so AI agents extend
   flows without breaking invariants.

## Success measures

- Free version: weekly npm downloads, GitHub stars, issues from real users, questions answered.
- Pro: paying customers, renewal rate, support load per customer (must stay low for a side project).
