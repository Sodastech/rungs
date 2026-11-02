"use client";

import { DemoUnavailable } from "../components/DemoUnavailable";

/** Never shows the error itself: what visitors see stays the same whatever went wrong. */
export default function ErrorPage() {
  return <DemoUnavailable />;
}
