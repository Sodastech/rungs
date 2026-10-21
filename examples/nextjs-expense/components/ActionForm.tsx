"use client";

import { type ReactNode, useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "../app/actions";

/**
 * A form bound to a Server Action that shows what happened: the action returns
 * `{ error }` or `{ success }`, announced to screen readers as well.
 */
export function ActionForm({
  action,
  children,
  className,
  label,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const [state, formAction] = useActionState(action, undefined);
  return (
    <form action={formAction} className={className} aria-label={label}>
      {children}
      <div aria-live="polite">
        {state?.error !== undefined && (
          <p className="alert error" role="alert">
            {state.error}
          </p>
        )}
        {state?.success !== undefined && <p className="alert success">{state.success}</p>}
      </div>
    </form>
  );
}

/** A submit button that shows it is busy while the action runs. */
export function SubmitButton({
  children,
  className = "button",
  name,
  value,
}: {
  children: ReactNode;
  className?: string;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      name={name}
      value={value}
      aria-disabled={pending}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
