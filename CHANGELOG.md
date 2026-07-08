# Changelog

## 0.1.2

Fixed a nondeterministic heal verdict on pages that rewrite identity attributes on a timer. On a page where two buttons swapped their id and title attributes every millisecond, the engine found the right element on every run, but the final confirmation read the element's attributes at a single instant, so the verdict depended on which phase of the swap that read landed in: some runs healed, others refused, from the same command on the same page.

The confirmation now pins the element once, reads its identity evidence twice over a short window, and watches for mutations in between. Any evidence that changed during the window is discarded before the match runs, including values the mutation watch saw pass through between the two reads. Stable evidence confirms exactly as before, so all previous eval results are unchanged. When the only evidence that would have matched was unstable, heal now refuses deterministically with the reason "element identity attributes are unstable; cannot confirm the match" instead of guessing.

A new eval fixture, hostile-mutation, locks the behavior: ten consecutive dry runs produce byte-identical output. The bug was found via a community challenge page.
