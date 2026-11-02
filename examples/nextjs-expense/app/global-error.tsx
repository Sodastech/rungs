"use client";

import { DemoUnavailable } from "../components/DemoUnavailable";
import "./globals.css";

/** The layout itself failed, usually because the database is out of reach. */
export default function GlobalError() {
  return (
    <html lang="en">
      <body>
        <main id="main">
          <DemoUnavailable />
        </main>
      </body>
    </html>
  );
}
