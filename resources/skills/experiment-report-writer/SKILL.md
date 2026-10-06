---
name: experiment-report-writer
description: Frozen projection of the upstream writer rules for physics and engineering experiment-report prose, structure, evidence boundaries, and document checks.
---

# Experiment Report Writer

## Snapshot and scope

This skill contains a **vendored, frozen projection** of the report-relevant modules from
[`xjsongphy/skills`](https://github.com/xjsongphy/skills) commit
`5d1aca1155fd42584095bb49bf87ea614c2875e8` (2026-10-05). It makes **no runtime
network request**. The selected upstream modules and their blob hashes are
recorded in [`provenance.json`](provenance.json). The AutoReport-specific
experiment-report guidance immediately below is a local addition; the frozen
projection follows it.

Use this skill to draft, revise, or audit the reader-facing body of a physics
or engineering experiment report. Apply a user-provided course, laboratory,
journal, or house template before the generic rules below. Write the body before
its abstract and keywords.

This skill does not prescribe agent roles, task/workflow tools, workspace
layout, data-analysis or plotting procedures, or compiler invocation. Those
concerns belong to the calling environment, subagent prompts, and dedicated
compilation skills. Do not invent measurements, experimental conditions,
figure paths, citations, bibliography metadata, or other unsupported facts.

## AutoReport experiment-report editorial contract

Write for a reader who knows the field but did not attend the experiment. Use
the course or user template to decide required sections and deliverables. Treat
upstream derivations, processed datasets, and figures as evidence and working
materials; select from them rather than reproducing their full contents. Cover
every required measurement while keeping the body centered on the experimental
question, observed behavior, analysis choice, and supported conclusion.

For AutoReport experiment reports, this editorial contract takes precedence
over the generic rules below when they conflict on level of detail, repetition,
or document structure.

### Default editorial selection pass

Before finalizing every report, make one selection pass even when the user has
not asked for a shorter report or set a page limit. For each paragraph, figure,
table, and derivation, ask whether it is needed to establish the experimental
question or necessary background, make the measurement reproducible, establish
a reported result, interpret a result or its uncertainty/limitation, or satisfy
an explicit template or course requirement. Remove material from the body when
it serves none of these purposes. Keep verification detail in an appendix or a
linked artifact when it remains useful and the template permits it. This is an
information-selection pass, not a word-count target.

Completeness applies to experimental coverage, not prose volume. Account for
every required measurement, but do not give every dataset, fit, or generated
figure equal space or its own subsection by default. Organize the report around
the experimental question and results; do not mirror the upstream artifact tree.

### Applying generic rules in AutoReport

Define each variable and unit in narrative before its first substantive use.
When a later equation reuses an unchanged variable, do not redefine it. A
single lead-in and interpretation may cover a tightly connected equation
sequence, figure group, or table group; do not wrap each element in repetitive
prose. Keep enough local context for readers to understand what the grouped
elements establish.

### Across the whole report

- **Introduction:** name the sample or system, what was measured, the question
  the measurement answers, and the approach. Include only background needed to
  understand that question. Do not retell the handout's history or list every
  later subsection.
- **Theory:** present the measurement chain and the few relations used to turn
  readings into reported quantities. State assumptions, sign conventions, and
  applicability before using a relation. Keep a derivation step when it explains
  an analysis choice, a limiting condition, or a comparison in Results; place
  independent, lengthy derivations in an appendix or a linked theory artifact
  when the template permits. A complete Theory-agent derivation is not by itself
  a reason to print every intermediate equation in the report.
- **Apparatus and method:** describe what was connected or controlled, the
  settings that affect interpretation, how readings were acquired and
  calibrated, and any observed deviation from the intended procedure. Give
  enough detail to reproduce the measurement without transcribing an operating
  manual or inventing unrecorded conditions.
- **Results and discussion:** for each measurement, state the observation, show
  the decisive figure or table, explain the reduction or fit needed to obtain
  the reported quantity, then compare it with the relevant model and its
  uncertainty. If an unexpected result changes the method or conclusion,
  establish its reliability before offering a mechanism. Separate measured
  facts from possible explanations.
- **Conclusion and abstract:** report the principal measured results and what
  they support. Keep the conclusion narrower than the full discussion; draft
  the abstract after the body and give the method, result, and conclusion in one
  compact account. Avoid repeating every fit, caveat, and subsection.
- **Appendices:** include required question answers and detailed grids where
  useful for verification. A requirement to tabulate a quantity at each bias
  point is satisfied by a clearly referenced appendix table when the template
  allows it; do not also reproduce the same grid in the body and a raw-data
  appendix. Preserve links to the full source data when the table is sampled.

### Human-report examples (adapted; illustrative values are not report data)

These examples paraphrase the local modern-physics reports on the electro-optic
effect and the Hall coefficient of silicon. Reuse the *reasoning pattern*, never
their measurements, apparatus settings, or conclusions in another experiment.

**A measurement problem changes the analysis.** An electro-optic report noted
that laser power drift left one bias sweep incomplete and that fitted extrema
disagreed with directly read extrema. It then used the directly read values for
the half-wave voltage. In a new report, give the actual observation and its
effect on the chosen estimator instead of adding a generic paragraph on all
possible sources of error.

**A condition explains why a reading is usable.** A silicon Hall report
recorded voltage only after the sample temperature settled, and rejected a run
if temperature changed substantially during current and field reversal. State
the analogous recorded control condition when it determines whether data may
be compared or fitted; omit routine switch-by-switch instructions.

**Theory stops at the reported inference.** In the electro-optic report, the
half-wave voltage relation connected the measured voltage to the electro-optic
coefficient used later. The report did not need every algebraic expansion again
at the point of fitting. In an experiment report, retain the equation, its
assumptions, and the step the reader needs to understand the reported value;
keep the full independent derivation in the theory working file.

**A conclusion selects.** A Hall report summarized the observed temperature
regimes and the derived quantities in two paragraphs. A conclusion should not
repeat every figure caption, fitting window, alternate model, and uncertainty
component after those have been discussed where they affect a result.

## Report contract (upstream `types/report.md`)

*Frozen from upstream heading: Report.*

Use this language-neutral module for technical, scientific, analytical, and
business reports. Apply the user or organization template first.

Give the document a clear title and scope statement. Keep raw records,
exhaustive grids, and long derivations in appendices or linked artifacts when
they would hide the main argument. Apply the shared technical-exposition rules
for placing and interpreting document elements.

## Structure

Use a purpose-driven shape: title and scope; context and question; method or
approach; results and analysis; limitations; conclusion; references; appendices
only when they support verification. Draft the abstract and executive summary
after the body. Keep conclusions within evidence established earlier.

## Argument

Give each section one job. Define important objects, variables, units, and
evaluation conditions before using them. For every result, identify the
measurement or source, comparison basis, uncertainty or limitation when
material, and implication. Do not turn tables or figures into unconnected
inventories.

Explain rows, columns, units, baseline, metric direction, and the trend that
changes the conclusion; do not narrate every cell. Place detailed raw data,
derivations, or exhaustive result grids in an appendix when the reader needs
the main argument first.

## Narrative flow

An element (list, table, formula, figure) always sits inside prose. **NEVER**
open a section directly with a list, table, formula, or figure; **ALWAYS**
lead with explanatory text that states what is shown, under which conditions,
and what pattern the reader should look for.

Use a "narrative → element → explanation" structure. The prose after an
element unpacks its meaning and significance, connects it to previous
findings, provides context for what comes next, and states practical or
theoretical implications when material. Do not stack several elements without
prose between them. A figure or table standing alone without narrative
interpretation is unacceptable.

**Bad** (element opens the section; elements stacked without prose):

> ## 结果
>
> [表 1]
>
> [图 1]
>
> [公式 (1)]

**Good** (narrative leads in and interprets each element):

> ## 结果
>
> 表 1 给出三种控温条件下测得的电阻值；响应随温度单调增大，与线性预期一致。
>
> [表 1]
>
> 对数据作最小二乘拟合，得温度系数
>
> [公式 (1)]
>
> 其中 $\alpha$ 为电阻温度系数。拟合残差在仪器误差范围内，表明线性模型适用；
> 图 1 将该拟合与测量点叠加显示。

## Physics and engineering experiment add-on (upstream `type-addons/report-experiment.md`)

*Frozen from upstream heading: Experiment report.*

This frozen projection already includes the report contract immediately above; apply both sections for physics and engineering laboratory reports.

State the measured scope, apparatus or setup, controlled conditions, analysis
method, and traceable source of every quantitative result. Let actual measured
data and supplied requirements define scope; mark unsupported requested items
instead of fabricating them.

## Structure and proportions

Use the usual order when no template overrides it: title page; introduction;
necessary theory; setup and procedure; results and discussion; conclusion;
acknowledgments (optional); references; appendix.

- The introduction stays within about one third of the body text.
- Results and discussion form the main body — more than half of the text —
  because they connect measurement, uncertainty, theory, and interpretation.
- Write the main sections first and draft the abstract (and keywords) last, so
  it summarizes what was actually written.

## Writing breakdown

Break a multi-section report into one todo per major section before writing,
and complete the sections one at a time; never draft the whole report in a
single pass. Place summary sections such as the abstract at the end of the
list. Split an oversized section further — data-table interpretation, figure
interpretation, theory–experiment comparison, systematic-error analysis,
limitations and improvements — rather than writing it in one burst. Mark a
todo complete only after its section is fully written and checked.

## Professional tone

- Use complete sentences and state facts directly. Say what you know, flag
  what you do not know, and never fake confidence.
- Do not use conversational filler such as “我们将探索”, “我们可以看到”,
  “值得注意的是”, "we will explore", "we can see", or "it is worth noting".

## Reader-relevance filter

Every sentence must give the reader content: a fact, definition, relation,
procedure, result, limitation, or interpretation. Remove meta-commentary
about the writing process or the author's intention — “这段话的目的是”,
“没有公开资料，因此不能推测” — unless the limitation changes the report's
conclusion. Do not justify an omission or wording choice merely because it
was made. When revising a report, do not restore deleted explanatory filler
simply because it explains why the text was written that way.

## Detail economy

An expert reader wants the argument, not the transcript of the measurement
session. Concretely:

- The abstract and the conclusion are mostly qualitative. Include a number
  only when the number itself is the headline result; do not enumerate ten
  values in an abstract.
- State each measured or fitted value once, where it is interpreted. Reuse it
  by cross-reference instead of restating the same number in theory, results,
  discussion, and appendix.
- Keep instrument operation sequences, switch settings, unit-conversion
  checks, and on-the-fly self-checks out of the report; they belong in a lab
  notebook, or in a procedure appendix only when the template demands it.
- Do not reproduce the full raw data grid in the main text. A compact table of
  the points the argument uses, or a plot, replaces the grid; ship a complete
  data appendix only when the course or template requires it.
- Discuss uncertainty in prose and name only the material components with
  their justification; do not build a component-by-component bookkeeping
  table when the budget is dominated by one or two terms.
- Verification side-trips — endpoint recomputation, alternative fits,
  residual spot checks — support confidence; report their conclusion, not
  every intermediate comparison.
- Answer appended thought questions in a few sentences each; they are not
  mini-essays and must not restate the body.

## Define before formula

**EVERY variable and unit must be defined in the narrative before it appears
in a formula.** Never introduce variables inside parentheses after a formula
as their first definition.

**Bad** (undefined variables):

> 根据公式 $F = kx$，其中……

**Good** (define first, then formula):

> 对于弹簧系统，胡克定律指出恢复力 $F$ 与位移 $x$ 成正比：
>
> $$F = kx$$
>
> 其中 $k$ 为弹簧劲度系数。

## Main-text lists

Avoid `itemize` and `enumerate` in the main text; an experiment report reads
as continuous prose. Use a list only when the template requires it, for
appendix data, or for genuinely parallel procedural steps.

## Worked example

A good section introduces its elements in prose, defines every variable, and
interprets each result (LaTeX):

```latex
\subsection{倍频法}

实验中观察到的倍频曲线如\autoref{double-frequency}所示。未加样品以及在电光
晶体后放置云母片时，利用倍频法测量得到的结果如\autoref{double-frequency-table}
所示。

\begin{figure}[H]
  \centering
  \includegraphics[width=0.5\linewidth]{fig/倍频}
  \caption{倍频曲线}
  \label{double-frequency}
\end{figure}

\begin{table}[H]
  \centering
  \caption{倍频法测量结果}
  \setlength{\tabcolsep}{0.4cm}{
    \begin{tabular}{ccc}
      \hline
      光路 & $V_\text{D0}$/V & $V_\text{DP}$/V \\
      \hline
      电光晶体 & -106$\pm$5 & 1269$\pm$5 \\
      加入云母片 & -619$\pm$5 & 996$\pm$5 \\
      \hline
    \end{tabular}}
  \label{double-frequency-table}
\end{table}

因此，半波电压为

\begin{equation}
  V_{\pi}= V_\text{DP}-V_\text{D0}=1375\text{ V}
\end{equation}

由\autoref{r63}，晶体的电光系数为

\begin{equation}
  r_{63} = \frac{\lambda}{2 n_\text{o}^3 V_{\pi 2}} = 16.8\times10^{-10}\,\mathrm{cm/V}
\end{equation}

其中 $V_{\pi 2} = 4V_\pi$ 为四块串联晶体的总半波电压，$\lambda = 632.8~\mathrm{nm}$
为激光波长，$n_\text{o}$ 为晶体寻常光折射率。
```

Points to note:

1. **Narrative first**: explanatory text introduces the figure and table
   before they appear.
2. **Variables defined before use**: $V_{\pi 2}$, $\lambda$, $n_\text{o}$ are
   defined where the formula that uses them is interpreted.
3. **Proper cross-references**: `\autoref{}` for figures, tables, equations.
4. **Complete captions**: figure and table captions are self-explanatory.
5. **Results explained**: each numerical result is interpreted in context,
   once.

The same section in Typst (identical narrative shape; only the syntax
differs):

```typst
=== 倍频法

实验中观察到的倍频曲线如 @double-frequency 所示。未加样品以及在电光晶体后
放置云母片时，利用倍频法测量得到的结果如 @double-frequency-table 所示。

#figure(
  image("fig/倍频.png", width: 50%),
  caption: [倍频曲线],
) <double-frequency>

#figure(
  table(
    columns: 3,
    table.hline(),
    table.header([光路], [$V_"D0"$ / V], [$V_"DP"$ / V]),
    table.hline(),
    [电光晶体], [$-106 plus.minus 5$], [$1269 plus.minus 5$],
    [加入云母片], [$-619 plus.minus 5$], [$996 plus.minus 5$],
    table.hline(),
  ),
  caption: [倍频法测量结果],
) <double-frequency-table>

因此，半波电压为

$ V_pi = V_"DP" - V_"D0" = 1375 "V" $

由 @r63，晶体的电光系数为

$ r_63 = lambda / (2 n_o^3 V_(pi2)) = 16.8 times 10^(-10) "cm/V" $

其中 $V_(pi2) = 4 V_pi$ 为四块串联晶体的总半波电压，$lambda = 632.8 "nm"$ 为
激光波长，$n_o$ 为晶体寻常光折射率。
```

Discuss systematic and random uncertainty only to the extent the data or
method supports it. Compare theory with measurement where the design permits
it, and state which conclusions are limited by measurement scope, data
coverage, or uncontrolled conditions.

## Shared technical writing rules (upstream `common/writing.md`)

*Frozen from upstream heading: Shared writing rules.*

This frozen projection includes the shared narrative and cross-type technical exposition rules. Three sections are conditional:
progressive depth, topic sentences for substantial artifacts, and length
revision. Do not apply those sections to a brief chat answer or local lookup.

## Narrative requirements

- Write for the reader's understanding, not to document the agent's research process.
- Start with the subject, mechanism, evidence, or consequence. Remove meta-commentary about what was searched, what the writer intends to do, or what the writer will avoid.
- Do not emit defensive process disclaimers. If a source limitation changes the interpretation, state the concrete limitation at the point where it matters; do not repeat it as a drafting explanation.
- Prefer positive, evidence-bearing sentences over negation-based assurances. State what the source establishes, what the excerpt illustrates, and where the boundary lies.
- Use the field's established term. When source objects are active, verify
  source-specific terminology against them. Do not coin a non-standard term or
  import a term from another document unless the current document uses it. If a
  Chinese rendering is needed, anchor it to the standard term on first use and
  use one term consistently. Do not cycle near-synonyms for one concept inside
  a paragraph; technical repetition of the established term is clarity.
- Prefer a number, a named mechanism, or the field's term over a generic
  quality adjective such as significant, novel, or 具有重要意义, unless that
  word is standard terminology in the active field. The same applies to 核心,
  关键, 重要, 主要, 本质, and 显著 used as a substitute for evidence: state the
  component's position, input and output, measured effect, or supporting source
  instead.

## Contrast economy

Default to direct assertions. Do not use “不是……而是……”, “并非……而是……”,
“而不是……”, “而非……”, “不等于……” or equivalent contrast merely to add
emphasis, announce the writer's process, or restate a fact in negative form.
Rewrite the sentence as a positive description of what the thing is and does.

Keep a contrast only when both conditions hold:

1. The rejected interpretation is genuinely plausible from the immediately
   surrounding text, figure, formula, or common reading.
2. Rejecting it materially changes the reader's understanding of a mechanism,
   evidence boundary, metric, or decision.

Operational test: would the sentence lose factual content if the negation were
removed and the remainder rewritten as a positive assertion? If yes, keep the
contrast. If no, it was rhetorical; cut it and state what the thing is or does.

## Quotation and sentence shape

Use quotation marks only for direct quotation, the first introduction of a
coined or scoped term, and code/identifier/schema-token references. Do not wrap
colloquial paraphrases, metaphor labels, or long explanatory clauses in quotes.
Match the document language's quotation glyphs: Chinese documents use “”,
English documents use ASCII `"..."`, and one document does not mix the two.

Every sentence should be grammatically complete and express one clear thought.
Write mechanisms as declarative prose. Do not use rhetorical self-questioning
as a substitute for stating the producer, transformation, output, consumer, or
rationale. Do not open a paragraph with an analogy or define a term primarily
by negation; both push the real explanation below the fold. State the input,
operation, output, and role first; an analogy may follow as intuition, and one
compact contrast sentence may follow when a term is likely to be misread.

**Bad:** “‘锁相放大’可以理解成一副只听某个音调的耳机：……” opens the paragraph;
“这里的 R 分量不是信号的几何半径” carries the definition.

**Good:** “锁相放大器将探测信号与参考振荡器相乘，经低通滤波取出同频分量” states
the mechanism first; “R 分量由参考通道相位处的振幅读出” states what the term
measures, before any contrast.

## Emphasis

Use bold sparingly, for genuinely important concepts, conclusions, or warnings,
integrated into complete sentences. Do not bold every introduced term and do
not open a paragraph with a bold label and a colon. Do not use italics for
emphasis; italics remain legitimate for paper titles, mathematical variables,
and conventional notation.

**Bad:** “**实验思路**：本实验采用四探针法测量方阻。” / “该图是本实验的核心结果。”

**Good:** “本实验采用**四探针法**测量方阻。” / “该图给出了方阻随退火温度单调
下降，对应晶粒尺寸的增大。”

## Clarity before detail

- Prefer the shortest explanation that preserves correctness, needed context,
  and recoverability.
- Do not explain every term, code line, or implementation detail by default.
  Expand when a later claim depends on it, the audience is unlikely to know it,
  the code is non-obvious, or a conclusion depends on a fine distinction.
- Do not repeat the same contribution or conclusion in the introduction, body,
  and summary unless each occurrence performs a different reader-facing job.

## Semantic density

- Give each paragraph one principal idea or one tightly coupled abstraction
  level. A paragraph carrying roughly four or five independent information
  points is a warning signal, not an automatic split instruction.
- Do not split a continuous causal argument mechanically. Instead, move exact
  mappings to a table, parallel conditions to a list, multi-stage flow to a
  diagram or pseudocode block, and mathematical relations to formulas.
- Use prose for causal reasoning and conceptual interpretation; use structured
  elements when their parallel or sequential structure is itself informative.

### Good / bad

**Bad:** one paragraph introduces the four parts of the vacuum setup, traces
the optical path, explains a calibration step, states a warm-up time, and
interprets the measurement.

**Good:** introduce each part's role first, show the optical path as a compact
diagram or table, explain the calibration in a focused paragraph, and
interpret the measurement where its result is introduced.

Worked example — one dense paragraph carrying eleven coupled points:

**Bad:**

> 图 2 左侧的 Sweep 控制器按箭头形成一个自动测量闭环。首先，`Set Point` 与
> `Range Check` 根据预设的起止频率和步长设定当前频点，并确认输出幅度在探测
> 量程内；它是可执行的控制指令，而不是最终测量结果。随后，`Acquire` 通过锁相
> 放大器读取同频振幅与相位，`Compute Impedance` 将振幅、相位与取样电阻换算
> 为复阻抗。`Validity Check` 将读数与噪声基底比较，`Flag Outliers` 只把超出
> 阈值的数据点标记为可疑；`Re-measure` 将可疑频点退回队列。最后，有效数据经
> `Log to File` 写入数据文件，`Next Point` 把扫描推进到下一个频点，使整条
> 曲线在一次运行中完成。图中的环形箭头表示该过程对每个频点重复执行。

**Good:** lead with the loop's arc, then one list item per stage:

> 图 2 左侧的 Sweep 控制器形成一个逐频点自动测量闭环：设定频点，采集读数，
> 剔除可疑值，记录后推进到下一频点。该闭环包含四个阶段：
>
> - **频点设定**：`Set Point` 与 `Range Check` 按预设起止频率和步长设定当前
>   频点，并确认输出幅度在探测量程内。
> - **采集与换算**：`Acquire` 从锁相放大器读取同频振幅与相位；`Compute
>   Impedance` 将其与取样电阻值换算为复阻抗。
> - **有效性检查**：`Validity Check` 将读数与噪声基底比较；`Flag Outliers`
>   标记超阈值数据点，`Re-measure` 将可疑频点退回队列。
> - **记录与推进**：有效数据经 `Log to File` 写入数据文件，`Next Point` 推进
>   扫描；环形箭头表示该过程对每个频点重复执行。

When the surrounding figure already shows the stages clearly, a two-sentence
summary may replace the list; choose by how much the reader must retain from
the prose alone.

## Topic sentences for substantial artifacts

Use this section only for a substantial or persistent document artifact.
Brief chat answers, citation lookups, and local lookups skip it.

Before writing a section's full prose, write the topic sentences first.
Read them in sequence; they must form a coherent argument on their own.
Fill in the paragraphs only after that sequence holds.

Each topic sentence is a contract for the paragraph that follows. State the
paragraph's message in the first sentence. If a paragraph cannot be tied to a
topic sentence, either the paragraph does not belong or a topic sentence is
missing.

After drafting a section, reverse-outline it:

1. Write the section's central claim or teaching goal.
2. Write each paragraph's topic sentence.
3. Write the evidence or explanation points under each paragraph.
4. Confirm every topic sentence maps to the section claim, and every evidence
   point maps to its topic sentence.
5. Revise, merge, or delete any paragraph that cannot be mapped.

A textbook section may introduce a concrete object or example before naming
it; the topic-sentence chain must still recover the teaching arc. Do not
require claim-first headings. Topic headings remain appropriate when they name
a required report, experiment, or textbook part.

## Concept before dependence

- Define a core noun, component, quantity, or acronym before analysis, code,
  diagrams, or formulas depend on it.
- Ordinary field terms need not receive standalone definitions. Keep one light
  parenthetical expansion for an acronym, and do not pack several definitions
  into one parenthesis.
- Distinguish a general mechanism from the current project or implementation
  when a survey or explanation moves between them.

**Bad:** “The lock-in amplifier outputs the in-phase component R” appears
before `R`, the reference channel, or the phase convention has been defined.

**Good:** define the reference channel and the phase convention first, then
state what `R` measures, how the data reduction uses it, and which details
remain unspecified.

A parenthesis carries at most one light expansion. Do not pack several
definitions into one:

**Bad:** “光电倍增管是 PMT（Photomultiplier Tube，一种利用二次电子发射逐级倍增
光电流的真空器件）的探测单元，包含分压器（为各倍增极提供逐级升高电压、通过
电阻链分压的电路）网络。”

**Good:** “光电倍增管（PMT）是一种利用二次电子发射逐级倍增光电流的真空探测
器。管内是逐级升压的倍增结构；分压器是为各倍增极供电的电阻链，其分压比决定
增益和线性范围。”

## Selective code and artifact explanation

- Give code or pseudocode context before the block and its behavioral takeaway
  after it. Short code needs only a concise before/after explanation.
- Explain line-level details only for non-obvious control flow, hidden
  assumptions, state changes, or decisive APIs. Do not use long code or comments
  as a substitute for conceptual explanation.
- Mark illustrative pseudocode and reconstructions explicitly. Source-faithful
  excerpts must follow the active object policy and include a path/line or other
  precise location when available.

**Bad:** paste the full 200-line instrument-control script and expect the
inline comments to explain the measurement procedure.

**Good:** show the few behavior-determining lines — the range switch and the
wait for trigger — identify their location in the script, and explain the
input, state change, and recorded output around them.

## Representation choice

Choose the smallest representation that makes the structure recoverable:

- prose for causal chains and interpretation;
- lists for parallel conditions, constraints, or procedures;
- tables for exact repeated mappings or comparisons;
- diagrams for architecture, pipelines, state transitions, or feedback loops;
- pseudocode for complex control flow;
- formulas for mathematical relationships.

Introduce each figure, table, code block, formula, or list with its purpose and
interpret it locally. For formulas that form part of a sentence, use punctuation
that completes the surrounding sentence. This is a prose rule, not a LaTeX-only
syntax rule.

**Bad:** place the three I–V curves for different bias settings together at
the top of Results and explain them in a later “Curve discussion” paragraph.

**Good:** state why each curve is needed, place it near the argument it
supports, and give its decisive reading — the threshold voltage shift —
immediately afterward.

## Progressive technical depth

Use this conditional sequence when a survey, paper explanation, or technical
teaching document must move from a readable map to operational detail and then
to the research or implementation-specific layer. It is not mandatory for
every report or textbook.

1. **Reader map**: state the problem, contribution, major objects, and the
   shortest complete end-to-end picture.
2. **Mechanism layer**: expose the representations, transformations, choices,
   state updates, interfaces, and consumers needed to trace one complete run.
3. **Research layer**: explain the design rationale, assumptions, comparison
   points, limitations, and evidence that distinguish this work from a generic
   mechanism.

Do not jump to implementation detail before the reader can place it in the map.
Do not stop at a slogan when the omitted mechanism determines the conclusion.
When source objects are active, use their policies to distinguish which layer is
source-established and which is inference or simplification. When the mechanism
layer contains retrieval, memory, agents, compilers, or another structured
system, use the active mechanism-analysis contract rather than defining a second
system-specific checklist here.

## Length revision

Use this section only when the user asks to shorten, compress, or meet a page
or word limit. Do not run it after every draft. Do not target a percentage
reduction.

Write the full argument first. Then ask of every paragraph: does this serve
one of the section's topic sentences? If not, delete it. Do not pad to fill a
page or word limit. A short document that preserves the argument is better than
a padded one that reaches a quota.

Allowed operations, in order:

1. **Shorten sentences.** Remove a clause that can go without losing meaning,
   needed context, or recoverability.
2. **Merge paragraphs** that make the same point with different examples; keep
   the strongest example.
3. **Replace generic adjectives** with a number, a named mechanism, or nothing.
   Keep a term that is standard in the active field.
4. **Delete tutorial material** only when it is in `assumed_known` or the
   audience contract says the reader already has it. Explanations and textbooks
   keep the smallest bridge listed in `explain_in_draft`.
5. **Promote dense numerical comparisons** to a table or figure and leave a
   local interpretation in prose. This applies the representation-choice rule
   as a revision; it does not add a new policy.
6. **Delete a closing sentence** whose only job is to restate the paragraph
   without a new fact, limitation, or next step.

Refuse deletion that would break an input/output, condition, state-update,
derivation, evidence chain, or a `not specified` boundary. After compression,
the topic-sentence chain must still read as a complete argument. Re-run the
document prose gate.

## Final prose check

Before returning a document, search for and remove sentences whose only purpose
is to justify the writing process, source-search process, or avoidance of
hallucination. Delete a paragraph-final sentence that restates the paragraph
without adding a fact, limitation, or next step. Scan for contrastive
constructions and quotation marks wrapping paraphrases; retain them only when
they resolve a real ambiguity or carry reader-facing information. Apply the
keep-vs-cut test to every retained contrast.

## Evidence and citation contract (upstream `common/evidence-and-citations.md`)

*Frozen from upstream heading: Evidence and citations.*

This file is the single canonical owner of source identity, claim-ledger, and
citation policy. Narrative style belongs to the shared technical writing rules above.

## Claim ledger contract

When a document makes source-dependent claims, maintain a compact working ledger
with one row per substantive claim:

```text
claim → evidence source → source location → evidence kind → confidence/boundary
```

The ledger is object-independent infrastructure. Active object policies define
the allowed evidence kinds, source locations, version scope, and unknown
boundary; a lens may ask a question but does not define source categories. The
ledger supports source review and claim checks, but is not copied into
reader-facing prose.

Use the strongest available primary source. Keep these identities distinct:

1. what a paper, handout, dataset, or other source states;
2. what an identified official implementation does;
3. a clearly labeled explanatory inference or simplification.

Third-party material may provide background or a comparison point when the
active object policy permits it. It does not upgrade an interpretation into a
claim made by the active primary source. Official project material is also a
separate source record unless the active object policy explicitly treats it as
part of the source scope.

Do not let a later code revision silently redefine a paper's evaluated method.
Do not create citations, bibliographic fields, data values, results, or source
locations. If a source does not establish an operational detail, omit it or
state the narrowest useful `not specified` boundary.

Treat source-specific operational disclosure as closed-world. A diagram arrow
or high-level verb establishes only the relation shown. Do not infer schemas,
defaults, state lifetimes, prompt fields, ranking operations, filters, or failure
paths. When a central question matters but the active sources are silent, retain
the smallest useful `not specified` boundary.

Place citations beside the claim they support. A citation must support the
nearest claim's scope, comparator, conditions, and strength; a broad method
citation does not prove an undisclosed API, default, state lifetime, filter, or
ranking rule.

Do not fabricate unavailable source identities, locations, APIs, configuration,
or implementation behavior. When source material is incomplete, use only its
disclosed algorithms, figures, appendices, and clearly labeled pseudocode.

## LaTeX format contract (upstream `formats/latex.md`)

*Frozen from upstream heading: LaTeX format.*

Use the supplied class and template before generic guidance. Keep document
semantics in sections, environments, labels, captions, and bibliography entries;
do not force presentation choices into prose.

- Use labels for display equations that will be referenced. Prefer `siunitx`
  for units when the template supports it.
- Use `\begin{equation}...\label{eq:name}...\end{equation}` for numbered
  display equations, and `\autoref{eq:name}` / `\eqref{eq:name}` (or
  `\autoref{fig:...}`, `\autoref{tab:...}`) for cross-references to
  equations, figures, and tables.
- Prefer a ruled style for tables — `ruledtabular` or booktabs rules — and
  align numeric columns on the decimal point (a `d{a.b}`-style column format
  when the class provides it). Give each figure and table a complete caption
  and stable label. Keep table width appropriate to content rather than
  filling a line by default.
- Use theorem-like environments consistently for textbook material. State
  language and font settings explicitly for CJK documents.
- Keep source files modular when a project has several chapters or sections;
  keep paths portable and references resolvable.

Inspect the rendered output when layout matters.

## Typst format contract (upstream `formats/typst.md`)

*Frozen from upstream heading: Typst syntax (report-relevant rules).*

Do not write LaTeX commands in Typst markup. The report-relevant mechanics:

- Inline math carries no spaces inside the delimiters (`$C_0$`); spaced
  delimiters (`$ C_0 $`) switch to display mode and break the formula out of
  the paragraph.
- Use `#figure` with `image`, `table`, or another block as its body; put a
  `<label>` after the element and refer to it with `@label`. Use
  `table.cell`/`table.hline` when spans or rules are needed.
- Give a numbered display equation a label after the math block
  (`$ F = k x $ <eq:hooke>`) and refer to it with `@eq:name`. Keep labels
  stable and use references instead of manually typed numbers.
- Style tables like ruled academic tables: `table.hline` for the top, header,
  and bottom rules (booktabs style, no vertical rules), `table.header` for the
  header row, and a fixed number of decimal places in each numeric column so
  values stay comparable.
- Keep reusable style in scoped `#set`/`#show` rules. For Chinese body text,
  use `#set par(first-line-indent: (amount: 2em, all: true), justify: true)`
  and turn the indent off for outlines, bibliographies, lists, and tables.

## Document release gates (upstream `checks/document.md`)

*Frozen from upstream heading: Document checks.*

These are deterministic release gates, not isolated reviewer roles. Run only
the sections whose trigger is active; brief chat answers and local lookups do
not require this document gate. Do not use this file to create a second writing
or evidence policy. The prose scan below detects violations of the shared technical writing rules above; it does not add new style rules.

## For document artifacts: prose

Apply the shared technical writing rules above together with the active report and language contracts as a pass/fail gate. Pass only when sections have clear purposes, paragraphs have
one principal job, and formulas, code, figures, tables, and lists have
contextual prose and local interpretation. Confirm that required definitions
precede use and that conclusions follow the established evidence without
introducing new results.

For a substantial artifact, also confirm a recoverable topic-sentence chain as
defined in the shared technical writing rules above. If reconstructing that reverse outline from the draft
is hard, fail and require a skeleton revision before release.

### Mechanical scan

A mental pass is not a run. Search the draft for the patterns below, record a
per-category hit count, and either fix each hit or keep it with an explicit
reason. Do not report this gate as passed without those counts.

**Keep-vs-cut for contrast.** For every “不是……而是……”, “并非……而是……”,
“而不是……”, “not X but Y”, or equivalent: would the sentence lose factual
content if the negation were removed and rewritten as a positive assertion?
If no, it was rhetorical; rewrite. Retain only contrasts that pass the two
conditions in the shared technical writing rules above.

**Process meta and throat-clearing.** Delete sentence openers whose only job
is to announce writing, importance, or a section change:

| English | Chinese |
|---|---|
| It is important/worth noting that | 需要注意的是 / 值得一提的是 |
| In this section we will discuss | 本节将讨论 / 接下来我们将 |
| We now turn our attention to | 下面我们来看 |
| In today's rapidly evolving | 在当今快速发展的 |
| This serves as a testament; it goes without saying | 这充分说明了 / 不难发现 |
| In order to, when *To* suffices | 为了能够 / 进行了深入分析 |

Keep an introduction roadmap that names forthcoming sections. Keep a heading
that names a required template part.

**Empty closers.** Delete a paragraph-final sentence that restates the
paragraph with no new fact, limitation, or next step.

**Generic adjectives and filler verbs.** Flag *novel*, *significant*,
*substantial*, *impressive*, *promising*, *comprehensive*, *robust*,
*powerful*, *delve*, *leverage*, *tapestry*, *realm*, *underscore*,
*multifaceted*, *nuanced*, *cornerstone*, *paradigm*, *synergy*, *holistic*,
*groundbreaking*, and Chinese equivalents 深入剖析, 赋能, 深刻揭示, 具有重要意义.
The bare emphasis words 核心, 关键, 重要, 主要, 本质, and 显著 count as hits when
they stand in for evidence; 关键路径 or a field-standard collocation is exempt.
Replace with a number, a named mechanism, or the field's term, or delete. If
the word is standard terminology in the active field (robust estimator,
paradigm in philosophy of science), it is exempt.

**Label-colon paragraph openers.** Flag openings like `**核心思想**：…`,
`**关键问题**：…`, or a bold label followed by a colon that replaces the first
sentence; rewrite the label into the sentence it introduces.

**Synonym cycling.** If one paragraph uses three or more near-synonyms for
the same concept, converge on the established term.

**Rule of three.** Do not pad a list or argument to three items. Two
load-bearing points beat three padded ones.

**Rhythm (warn only).** If five or more consecutive sentences fall in a
narrow length band, vary them. Methods, procedures, and proof steps may stay
even. Do not fail the gate on rhythm alone.

Do not ban hedging, passive voice, or em-dashes as such. Uncertainty,
conditions, and constructions such as “is given by” remain legitimate in
reports, textbooks, and derivations.

## If a claim ledger exists: source and claims

For each substantive claim, confirm its source, conditions, comparator, and
strength. Verify every cited source exists and supports the nearest claim. Keep
claims from different active objects and explanatory inferences visibly
separate. Remove invented results, citations, interfaces, state transitions,
defaults, formulas, and numerical details.

For experiments, trace every quantitative statement to measured or supplied
data. When the claim ledger is non-empty, use it to preserve source locations,
version scope, and uncertainty boundaries where active sources omit a behavior
needed to interpret the subject.

## If a rendered artifact exists: rendered document

Ensure the artifact is successfully compiled or rendered through the active
build workflow, then inspect the actual output. Check page breaks (chapter-like
titles start a page when the format requires it), first-line indent after
headings, heading gaps, orphaned headings, overflow, font fallback,
math, tables, figures, captions, cross-references, citation resolution, and
image readability. Correct the source and rerender until the observed artifact
matches the requested template and no material layout defect remains.
