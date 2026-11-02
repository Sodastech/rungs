// Release status, in one place. While `released` is false, every page shows a "not released yet"
// banner and the install commands point to the source instead; search the site for `released`.

export const released = true;

export const repository = "https://github.com/Sodastech/rungs";

/** Where to get notified of the first release. */
export const watchReleases = repository;

/** How to try Rungs before it is on npm. */
export const tryNow = {
  clone: `git clone ${repository}.git\ncd rungs\npnpm install`,
  demo: "pnpm demo",
  playground: "pnpm playground scenarios/01-expense-three-steps.ts",
};
