---
"@rungsjs/core": minor
---

Without `onEvent`, events now stay pending in the outbox for a worker running `dispatchPending`
(EC-58); `events: "discard"` opts out of the outbox. New `ConfigurationError` (`CONFIG_INVALID`)
for unusable `createRungs` options.
