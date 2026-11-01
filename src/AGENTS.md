# src: the engine

Zero runtime dependencies: node built-ins and plain fetch only. Reads repos as text and never executes them.
Output carries version 1, and fields are only ever added. docs/contracts.md section 5 is the run shape.
Every model claim passes src/checks.ts before anyone sees it. Don't special-case a repo.
Tests live in test/. Don't edit the answer key to make a test pass; a person re-reads it.
