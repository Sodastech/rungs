---
"@rungs/core": patch
---

Fix: a manual delegation or task reassign to someone whose own vote is already in the step through
a delegate is now refused, so nobody can end up with two votes in one step (EC-48). Found by the
property tests.
