## Yak pager

Core logic is in runPass in paginationPlugin.ts. It has 3 phases:
- Measure.
- Solve.
- Decorate.

The apply hook keeps track of what ranges were modified across transactions.

Then runPass gets scheduled every 100ms from schedule. That is the meat of the logic.

Some interesting bits are -
- split candidates - this is where it calculates split positions of every line in a para.
