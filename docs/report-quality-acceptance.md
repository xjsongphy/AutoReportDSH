# Report-quality acceptance after the electro-optic session review

The automated suite checks packaging, role contracts, and the exact migration of
plotting instructions. It does not establish that a live model follows those
instructions. Use the following source-grounded cases when reviewing a newly
run report; retain the session trace and the resulting artifacts. No live-model
run is part of this change.

## Coordination and evidence

- A reduction requiring newly requested theory declares that dependency. Record
  inventory may run independently. The trace shows the analysis reading usable
  theory before applying its model.
- An unclear input is sent to the responsible specialist as a question. MAIN
  checks required versus delivered scope and routes unresolved required results
  even when an upstream task reports success; MAIN does not recompute results.
- A value present in a column definition, original record, or supplied reference
  is not called missing without checking that source. Measurements, nominal
  parameters, qualified estimates, and genuinely missing inputs remain distinct.
- Method comparisons align physical definitions, conversion factors, units,
  offsets, and signs. Extrema agree with the trace and their run labels.

For the reviewed electro-optic dataset, this includes the four-crystal factor
on both methods, the conflict around the parallel-scan extremum, compensation
column meanings, and the supplied nominal thickness. These are case-specific
review questions, not constants or formulas in generic runtime prompts. The
human reference report is also checked for arithmetic consistency.

## Figures

- Compare the plotting persona with the original snapshot in
  `tests/fixtures/autoreport-plotting-original.md`; only the interface changes
  listed in `resources/personas/plotting_agent.provenance.json` are permitted.
  The first Plotting prompt contains these instructions without a skill call.
- Inspect final figures at their size in the report. Check explicit colors and
  distinct marker shapes, hollow markers, font family and size, mathematical
  labels, units, line widths, resolution, curve separation, and axis usage.
- Theoretical comparison and uncertainty displays follow the original plotting
  requirements. If the necessary analysis is unavailable, the trace records
  the specific upstream question; inability to fit is not by itself evidence
  that no theoretical comparison can be made.
- Every measured condition is accounted for by a figure or an existing table.
  Explicit course requirements control overlays, tables, and observational
  figures. Sources and per-figure self-checks are present in the handoff.

## Report

- Required results, tables, observations, and questions are covered or returned
  as specific unresolved upstream issues. Compilation alone does not complete
  the scientific task.
- Review sections before summaries. The narrative follows the experiment's
  observation, analysis choice, result, and interpretation; caveats appear where
  they affect the conclusion rather than being repeated throughout the report.
- REPORT cross-checks supplied sources and requests upstream corrections, while
  keeping calculations and scientific figure changes with their owning roles.
