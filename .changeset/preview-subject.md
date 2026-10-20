---
"@rungs/core": minor
---

`preview` requires `subject` and validates its input like `submit`, so resolvers that look data up
by subject never receive a stand-in.
