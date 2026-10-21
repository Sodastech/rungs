import { advanceAction, resetAction } from "../app/actions";
import { formatDateTime } from "../app/format";
import { ActionForm, SubmitButton } from "./ActionForm";

/**
 * The demo clock. Moving it forward runs `rungs.tick()`, which applies the reminders,
 * escalations and timeouts that became due. A real app runs `tick` on a schedule.
 */
export function ClockBar({ now }: { now: Date }) {
  return (
    <section className="clockbar" aria-label="Demo clock">
      <div className="clockbar-inner">
        <span>
          Demo time <time dateTime={now.toISOString()}>{formatDateTime(now.toISOString())}</time>
        </span>
        <ActionForm action={advanceAction} label="Move the demo clock forward">
          <span className="visually-hidden">Move time forward:</span>
          <SubmitButton name="hours" value="1">
            +1 hour
          </SubmitButton>
          <SubmitButton name="hours" value="24">
            +1 day
          </SubmitButton>
          <SubmitButton name="hours" value="72">
            +3 days
          </SubmitButton>
        </ActionForm>
        <form action={resetAction} className="reset">
          <span className="demo-note">Demo only: no real sign-in.</span>{" "}
          <SubmitButton>Reset demo</SubmitButton>
        </form>
      </div>
    </section>
  );
}
