export function DemoUnavailable() {
  return (
    <>
      <h1>The demo is resting</h1>
      <p className="lede">
        Something went wrong, or the demo has reached its free usage limit. Please try again later.
      </p>
      <p>
        You can also{" "}
        <a href="https://github.com/Sodastech/rungs/tree/main/examples/nextjs-expense">
          run it on your own computer
        </a>
        , with no database to install.
      </p>
    </>
  );
}
