---
name: plotting-quality
description: Design, generate, and inspect publication figures for physics experiment reports from validated analysis results. Use for Plotting role figure work; not for fitting raw measurements or writing reports.
---

# Plotting quality

Use validated analysis and theory as figure inputs. Visualization-local sorting, interpolation, coordinate conversion, and curve evaluation are permitted; changing scientific results belongs to Data Analysis. If required analyzed values or formulas are missing, report the dependency to MAIN.

## Plan coverage and presentation

- Check the data list in `Data/Processed/analysis.md` or equivalent analysis output. Cover every physically meaningful measured quantity and condition in figures or identify an existing analysis table that carries it. Do not silently discard a measured condition or use only a representative subset. Ask MAIN through `report_workflow` before omitting one.
- Consolidate comparable datasets that share a physical quantity and independent variable in a multi-panel figure or overlay. Split when an overlay has roughly more than six indistinguishable curves, units differ, or a figure would need more than eight panels.
- Overlay theoretical curves when a comparison is relevant. Make prediction and measurement visually distinct. Include error bars when the analyzed uncertainty supports them.
- Use English for all visible figure text unless the user requests Chinese. Give axes units in parentheses and use publication-quality mathematical notation.

## Draw readable figures

- Set an explicit style for each dataset; avoid matplotlib's default filled blue dots. Pair a colorblind-safe qualitative color (such as Okabe-Ito or a distinct sample from viridis, plasma, or cividis) with a distinct marker shape. Avoid red-green pairings.
- Prefer hollow measured-data markers (`markerfacecolor='white'` or `'none'`, colored edge), small markers around 4–6 points, and thin edges around 0.8 points. Use a contrasting thin solid fit or theory line, around 1–1.5 points. When a fit or theory curve is present, draw measurements as markers without a connecting line unless they are genuinely ordered and continuous.
- For a smooth or monotonic ordered trend, a thin line with markers can help the reader follow the data. For categories, independent replicates, or data without meaningful continuity, use scatter only. Sort x before any connected line; matplotlib otherwise joins rows in input order.
- Evaluate an existing fit or theoretical function on a dense grid spanning the measured x-range (for example, `np.linspace(x.min(), x.max(), 200)`). Keep measured points and every overlaid curve aligned to the same coordinate convention. Never refit raw data here to create new results.
- Inspect apparent jumps near angle, time, or other periodic boundaries and unit prefixes. Correct a documented visualization coordinate wrap or unit conversion without deleting measurements or altering stored analysis values; escalate an unexplained scientific discrepancy.
- Check whether multiple curves are distinguishable across their full x-range. A useful estimate of line/marker height in data coordinates is `visual_h ≈ (lw_pt + ms_pt) / fig_h_pt × (y_max − y_min)`. Resample curves on a common x grid with `np.interp` when needed; if separation is below that height over about 80% of the range, reduce line/marker size, split into panels, or use clearer line styles.
- Choose limits so a single dataset occupies about 80% or more of its axis where practical. For merged curves, use at least about half the axis range. Do not clip data, uncertainties, or meaningful comparisons merely to meet a space target.
- Use legible 8–12 point fonts; Times New Roman when available. Typical graph export is 600–1000 DPI, photographs 300–600 DPI, with at least 300 DPI for final figures. Choose Chinese fonts such as SimHei or STSong only when Chinese text is requested and supported.

## Generate and inspect

Set `plt.rcParams['axes.unicode_minus'] = False` where matplotlib is used and call `plt.close` after saving each figure. Save images under `Plots/Fig/` and reproducible scripts under `Plots/Scripts/`. Record content, data source, and theory overlay for each figure in `manifest`.

Before reporting completion, check every figure and fix, rerun, and recheck failures:

1. Connected x values are monotonic.
2. Negative signs render, and figures are closed after saving.
3. Every analyzed dataset and required condition is represented in a figure or accounted for by an existing analysis table.
4. Trends are plausible against theory; investigate anomalies as possible data or plotting issues without recomputing upstream results.
5. Curves and conditions remain visually distinguishable.
6. Axes use available space without clipping important content.
7. Existing fit or theoretical curves span the measured range and align with the points.

Give MAIN a brief per-figure check result with any omission and its reason. If a failure points to the analyzed result rather than the rendering, report it to MAIN for Data Analysis.
