---
"@rungsjs/core": minor
"@rungsjs/store-memory": minor
---

The approver a delegated task acts for can approve, reject or return it directly, without taking it
back first (EC-60). The first decision closes the task; decision events gain `onBehalfOf` and
`heldBy`, tasks gain `decidedBy`, and the owner's inbox lists the task with `heldBy`. Store
adapters: `findInbox` also returns tasks held on the user's behalf.
