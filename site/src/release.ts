// Release status, in one place. At the 0.1 release (ROADMAP, Phase 3): set `released` to true.
// That removes the banner on every page and the "after the 0.1 release" notes on the install
// commands; search the site for `released` to check nothing else depends on it.

export const released = false;

export const repository = "https://github.com/Sodastech/rungs";

/** Where to get notified of the first release. */
export const watchReleases = repository;

/** How to try Rungs before it is on npm. */
export const tryNow = {
  clone: `git clone ${repository}.git\ncd rungs\npnpm install`,
  demo: "pnpm demo",
  playground: "pnpm playground scenarios/01-expense-three-steps.ts",
};
