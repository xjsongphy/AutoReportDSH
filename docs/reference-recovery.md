# Source recovery before requesting more measurements

## Missing-input reports

When `report_workflow` delivers `blocked / missing_data` to MAIN, the tool adds
host-owned recovery guidance after the unchanged JSON report envelope. It is
part of the actual report delivery, not a permanent system-prompt section and
not an invented child statement. The report parser still reads the canonical
JSON; settlement, idempotence, and stale-result checks remain unchanged.

MAIN first routes a focused source check. Existing reference documents,
extracted tables, captions, corrections, units, and prior answers must be
checked before requesting a new measurement. Absent, ambiguous, and poorly
extracted inputs need different responses.

For source lookup alone, plan a small audit task reusing existing artifacts.
Keep completed scientific artifacts unchanged during the audit and return source
locations. Do not reopen completed scientific work merely to ask a question. If an audit
finds that a scientific output must change, reopen its original task; dependent
results must then be rebuilt. This preserves result freshness rather than
hiding dependency changes. Run only the identified scope.

The observed electro-optic run explicitly reopened `task-theory`, updated
`task-data`, and ran `task-data`. The requested scope includes prerequisites,
so THEORY and DATA_ANALYSIS ran again in their retained child Sessions. That
was a broad repair choice by MAIN, not a requirement to recreate every Agent
after any user reply.

## Original-page fallback

Normal `extract_pdf(path)` still uses MinerU. Only after MinerU fails or its
output is insufficient may MAIN use:

```json
{"path":"References/record.pdf","page":3,"extraction_issue":"MinerU omitted the handwritten dimension and its diagram association on this page."}
```

The tool requires reusable extracted Markdown next to the source PDF or a
recorded MinerU extraction outcome in the current Session. A call mentioning
MinerU or an unrelated tool error does not qualify. `page` and
`extraction_issue` are paired; page numbers, workspace confinement, PDF source
root, and image-input capability are checked before rendering.

The selected AutoReport Python environment needs `pymupdf`. If unavailable,
the result names that package so MAIN can use the existing approval-backed
`install_python_package` tool. No system Poppler installation is needed for
this fallback. A fixed Python program renders one page with a 60-second
process deadline and a maximum dimension of 2000 pixels. Argument values are
passed separately from Python source. PNGs are written only under
`Outline/.cache/reference-preview/`, never into a source PDF or extraction.
MAIN points the responsible specialist to the returned image for `read_image`;
this does not transfer scientific interpretation to MAIN.

## Next report test

Use the NaI(Tl) gamma-ray spectroscopy experiment in the local Resources
collection (`近代物理实验I/NaI测定Gamma射线能谱`). It contains Cs-near, Cs-far,
and combined spectra in `.dat.txt`/`.mca` files, the original handout and
operation guide, observation images, and a human report for independent review.
The three text spectra each contain 1024 count rows and are directly readable;
check encoding and line endings before parsing counts.
Evaluate energy calibration, peak/background treatment, resolution, comparison
across source positions, figure presentation, and student-author narrative.

Give the experiment workspace raw inputs, handouts, and observation records.
Keep the completed human report and existing fitted figures outside its read
scope so they remain an independent comparison, not answer-bearing inputs.
Do not infer actual acquisition conditions from the reference report alone.

Pulse NMR is a useful second test: its six IR/CPMG text traces for three CuSO4
concentrations, waveform images, data-description file, and manuals exercise
nonlinear fits and multi-condition plots. Start with T1/T2 relaxation; leave
DICOM imaging for a later, separate scope. Hall-effect reports in the collection
are good prose comparisons, but the inspected folder has no separate raw data
or handout, so it is not the best next end-to-end fixture without more inputs.

No live-provider report was run and no experiment artifacts were edited as
part of these tool changes.
