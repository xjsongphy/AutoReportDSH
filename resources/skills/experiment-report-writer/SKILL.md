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

This is a physics laboratory report submitted for course assessment. Use the
experiment requirements, course conventions, and supplied template to determine
its scope, depth, and required deliverables. Demonstrate understanding of the
physical principles, measurement method, data reduction, and experimental
findings through a coherent scientific argument. Develop the required analysis
and interpretation at the level expected by the course.

This contract governs experimental inference, author voice, evidence selection,
and report structure when the generic modules below differ. Their evidence and
citation rules still require truthful measurements, conditions, and attribution.
By default, instructions to mark unsupported items or retain a source's silence
belong to internal evidence review; they do not require missing-material
paragraphs in the submitted report. When the task or the user explicitly asks
that undetermined or unmet objectives be stated in the report, that instruction
overrides the default: state each unmet objective once, concretely, tied to the
objective it blocks. A course requirement to discuss experimental limitations is
met through the effects on the measured results and their interpretation.

The omission boundary is easiest to violate by narrating what the data could
not support instead of reporting what it does. The following pairs are patterns,
not facts to reuse; adapt the quantities to the experiment at hand.

**Unsupported quantity — omit it and its explanation; keep the supported part:**

> Bad: 因缺少样品厚度，本实验无法完成电阻率的计算，该目标未能实现。
>
> Good: （报告保留由测量直接支持的伏安特性及拟合电阻；电阻率需要样品
> 几何参数，超出本次记录范围，正文不出现该目标。）

**Unverified condition — attach the qualification to the result it changes:**

> Bad: 各次测量的环境温度均未记录，温度效应无法评估，结果的可靠性
> 不能确定。
>
> Good: 因未记录环境温度，所得电阻率不作温度修正，仅在该近似下使用；
> 两次测量的差异仍在拟合残差范围内。

**Meta-discourse about sources — keep in internal notes, not the report:**

> Bad: 本报告只陈述经核验的内容；讲义中的部分要求因材料不足未予讨论。
>
> Good: （删除该段。受影响的目标要么上游解决，要么在任务或用户明确要求
> 披露时按下一条处理。）

**Requested disclosure — state each unmet objective once, concretely:**

> Good: 讲义要求的能量分辨率测定，因缺少本底谱与测量时间记录，本次无法
> 给出数值结果；已完成的谱形比较不受此影响。

### Author voice in the report body

Write as the author of the course experiment report. Develop the account from
what was measured, how the measurements were analyzed, and what the results
mean. First-person pronouns are optional. Describe apparatus, controls,
observations, calculations, and physical reasoning directly, with evidence for
any claimed operation or experience. Never invent personal experience or remove
a material experimental uncertainty to make the account sound complete.

**Organize content around physical questions; write headings as declarative
noun phrases.**
Let the experiment's objectives decide which theory, methods, figures, and
tables each section carries. Express that organization in declarative
noun-phrase headings that name the measurement, quantity, or topic, in the
course report's own language (能谱与定标, 多道分析器测量结果), never as
questions (不写 能谱能否由记录确定？). Subdivide Theory by physics topic
(康普顿散射, 能量分辨率) and Apparatus and method by measurement stage or
component (实验装置, 测量过程) whenever the course material covers several.
Preserve the course's required measurements, analyses, tables, and questions.

**Develop the experimental argument.** Identify the observed trend, feature, or
difference; explain the adopted reduction and its physical basis; present the
result; connect it to the model or the experimental question. Arrange these
parts naturally across paragraphs and figures. They are reasoning functions,
not a mandatory sentence order or a five-part paragraph template.

**Use analysis to produce knowledge.** Observations provide measurements and
references provide models and applicable constants. Fitted parameters, widths,
calibration relations, and propagated uncertainties are ordinarily derived
results. A result need not already be printed in the raw record to be supported
by a valid calculation. Use verified upstream analysis for those results;
resolve unfinished essential calculations upstream before finalizing the report.

**Make discussion explain the findings.** Explain why a measured trend occurs,
why conditions produce different responses, or how a deviation affects the
adopted analysis. Separate an established observation from a proposed mechanism.
Match the strength of the interpretation to its evidence. An unexpected result
may be a central finding when its reliability has been checked.

**Attach qualifications to the results they change.** State the assumptions,
assessed uncertainty, and observed experimental effects needed to interpret a
retained result. Explain their specific consequence for the number, comparison,
or physical inference. A statistical error estimate can be reported with its
meaningful scope. Select material effects instead of listing every conceivable
error source. Observed ambiguity, an unsuccessful measurement, or disagreement
with a model can itself be a supported experimental finding.

Source reconciliation, file consistency checks, and decisions about which
supplied material to use stay in internal notes. Optional unsupported content
is omitted. Unresolved required outcomes return upstream for analysis or scope
resolution; an omission explanation does not fulfill them. Keep evidence that
is necessary to understand a retained claim, even when it limits the conclusion.

### Positive examples of experimental reasoning

These are illustrative prose patterns, not facts, results, or apparatus details
to reuse. Every observation, diagnostic, and causal claim in an actual report
must be established for that experiment. Supply verified values, uncertainty,
and figure references where appropriate; adapt the reasoning rather than
copying the sentences.

**A measured relation supports a result:**

> 样品两端的电压随电流近似线性增加，伏安曲线如图所示。采用
> $U=RI+U_0$ 拟合，其中斜率 $R$ 表示样品电阻，截距 $U_0$
> 描述电压零点偏移。由拟合斜率得到样品电阻，结果见表。
> 残差在测量范围内未呈现明显的系统趋势，说明线性模型能够描述本次测量结果。

The relation, reduction, result, and model check form one argument. The actual
report supplies the measured value and the diagnostics that justify the check.

**An observed effect motivates a methodological choice:**

> 改变加热功率后，样品温度逐渐趋于稳定，热电压随之变化。
> 为比较不同温度下的响应，取每次温度稳定后的电压进行拟合。
> 所得热电压随温差近似线性增加，由斜率求得该温度范围内的塞贝克系数。
> 升温与降温测量的差异反映了温度滞后对结果的影响。

Use this pattern only when the time dependence, selected stable measurements,
and heating/cooling comparison have actually been established. It explains a
choice through the measured phenomenon and its effect on the result.

**An assumption defines the interpretation of a result:**

> 固定样品电流时，霍尔电压随磁场近似线性变化，反向磁场下电压符号改变。
> 取正、反磁场电压的反对称分量消除与磁场方向无关的电压偏置，
> 由其磁场依赖求得霍尔系数。在单一载流子近似下，进一步得到载流子浓度；
> 该浓度表征这一近似下的有效载流子密度。

The assumption accompanies the inference it enables. Its applicability must be
justified by the supplied model and analysis, not invented during prose editing.

### Default editorial selection pass

Before drafting, map the required experimental questions to adopted upstream
results and decisive observations, figures, or tables. Resolve a missing
required result with its owner. Choose the scientific result that answers each
question; an easily computed proxy or an input inventory does not automatically
answer it. Keep detailed provenance and unresolved source questions in internal
notes, separate from the adopted scientific account.

Build Results and Discussion first. Present the observation, explain the
analysis choice, give the verified result, and develop its physical meaning
with enough method detail to follow the inference. A waveform, qualitative
observation, or measured anomaly can be decisive evidence without a fitted
number. Include actual assumptions and limitations where they change the
interpretation. Select between supported analysis alternatives on scientific
grounds; refer unresolved choices that change a required conclusion upstream.

Review each section using three questions:

1. What experimental question does this section answer?
2. Which observation and analysis support its conclusion?
3. What physical understanding does each paragraph add?

Retain the methods and conditions needed to understand or reproduce the
measurement. Keep source availability and report-assembly decisions in internal
notes. Apply this selection to captions and appendices as well as the body.
Review the whole argument before drafting the abstract and conclusion from the
principal findings. These summaries answer the experimental objectives at the
strength supported by the results.

### Sections and course requirements

Follow the supplied template's section skeleton and keep its heading wording
when it is usable; rename a section only when the course material demands a
different scope. Write subsection headings in the same declarative style
described in the editorial contract. Sections that span several independent
topics or measurement stages get named subsections rather than one flat block.

- **Introduction:** state the physical system, experimental objectives, and
  approach. Use brief background to motivate those objectives at the course's
  level; keep required theory and results central.
- **Theory:** develop the relations needed to obtain or interpret the reported
  quantities, with variables, assumptions, and conventions introduced before
  use. Give each physics topic its own subsection (光电效应, 康普顿散射,
  能量分辨率). Keep derivation steps that demonstrate the required understanding;
  place lengthy independent derivations in an appendix when permitted.
- **Apparatus and method:** describe the setup, controlled conditions, and how
  measurements were acquired and calibrated, with sufficient detail to reproduce
  the experiment. Organize by component or measurement stage (实验装置,
  实验过程) when several are involved. Include observed departures that affect
  the analysis.
- **Results and discussion:** connect measured behavior, adopted analysis,
  quantitative or qualitative findings, and physical interpretation. Explain
  discrepancies through relevant evidence and distinguish possible mechanisms
  from demonstrated causes.
- **Abstract and conclusion:** answer the experimental objectives through the
  principal findings and their meaning, retaining a condition or uncertainty
  when it changes that answer. Write them after the body.
- **Appendices:** retain course-required tables, question answers, and detailed
  data or derivations useful for verification. Reference them where they support
  the main argument; avoid duplicating the same grid in several places.

### Mathematical presentation

Keep short symbols, values, and simple relations inline. Prefer display math
for long formulas, chained equalities or substitutions, large fractions, and
multi-term model relations. Introduce the relation in prose, put it on its own
line, and interpret it afterward. Split an overlong expression at a meaningful
equality or operation; do not squeeze it into a paragraph or shrink the font.
A formula need not be referenced later to deserve display math. Label equations
that are referenced; follow the active language guidance for the syntax.
Define variables and units before their first substantive use; unchanged
variables need not be redefined around every equation. A connected sequence may
share a lead-in and interpretation when its meaning remains clear.

### Figure captions

State the measured relationship and the conditions needed to read the panels
concisely; stay within one or two sentences. Leave analysis and interpretation
to the body unless one short sentence is necessary to establish the figure's
scientific meaning. Do not restate selection criteria, data file names, or
conclusions established elsewhere, and avoid repeating information already
carried by axes or legends. Source checking and editorial decisions follow the
same internal-work boundary as the report body.

## Report contract (upstream `types/report.md`)

Use this language-neutral module for technical and scientific reports. Apply
the user or organization template first.

Give the document a clear title and scope statement. Keep raw records,
exhaustive grids, and long derivations in appendices or linked artifacts when
they would hide the main argument. Apply the shared technical-exposition rules
for placing and interpreting document elements.

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

Apply this add-on together with the report contract above for physics and
engineering laboratory reports.

State the measured scope, apparatus or setup, controlled conditions, analysis
method, and traceable source of every quantitative result. Let actual measured
data and supplied requirements define scope; report an unsupported requested
item as an unresolved upstream question instead of fabricating it or narrating
it in the report body.

## Structure and proportions

Use the usual order when no template overrides it: title page; introduction;
necessary theory; setup and procedure; results and discussion; conclusion;
acknowledgments (optional); references; appendix.

- The introduction stays within about a tenth of the body text; necessary
  theory within a quarter to a third.
- Results and discussion form the main body — more than half of the text —
  because they connect measurement, uncertainty, theory, and interpretation.
- Write the main sections first and draft the abstract (and keywords) after
  the body, so it summarizes what was actually written.

## Professional tone

- Use complete sentences and state facts directly. Say what you know, flag
  what you do not know, and never fake confidence.
- Do not use conversational filler openers such as “我们将探索”, “我们可以
  看到”, “值得注意的是”, "we will explore", "we can see", or "it is worth
  noting". This bans the filler phrase, not the pronoun 我们 itself; the
  first-person rule in the editorial contract still applies.

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
  only when the number itself is the headline result, and then with its
  uncertainty; do not enumerate ten values in an abstract.
- State each measured or fitted value once, where it is interpreted. Reuse it
  by cross-reference instead of restating the same number in theory, results,
  discussion, and appendix.
- Keep instrument operation sequences, switch settings, unit-conversion
  checks, and on-the-fly self-checks out of the report; they belong in a lab
  notebook, or in a procedure appendix only when the template demands it.
  Name key instruments by model and manufacturer with the constants later
  steps need, each with its uncertainty, and compress operations into one
  parameterized paragraph of conditions and criteria instead of a step
  narrative.
- Present each headline derived quantity as a labelled equation, and compare
  it with theory or literature later through that reference.
- Do not reproduce the full raw data grid in the main text. A compact table of
  the points the argument uses, or a plot, replaces the grid; ship a complete
  data appendix only when the course or template requires it.
- Discuss uncertainty in prose and name only the material components with
  their justification; do not build a component-by-component bookkeeping
  table when the budget is dominated by one or two terms.
- Verification side-trips — endpoint recomputation, alternative fits,
  residual spot checks — support confidence; report their conclusion, not
  every intermediate comparison.
- A discussion paragraph answers one question. When a result deviates from
  expectation, give the observation, the decisive check, and the resulting
  limitation in one paragraph; longer alternative-exclusion chains (competing
  models, frequency scans, control samples) belong in the analysis artifact —
  the report keeps their conclusion and the strongest single counter-evidence.
- Answer appended thought questions in a few sentences each; they are not
  mini-essays and must not restate the body.

### Prose patterns

**Numbers travel in groups.** A reported value appears with its uncertainty
and a reference point — threshold, theoretical expectation, nominal value, or
an independent measurement — together with what the comparison supports or
rules out. Do not list numbers for archival alone.

**Bad:** “拟合斜率为 -1.3，截距 13.3，$x$ = 1.3，$A$ = 6.0×10⁵。”

**Good:** “拟合得 $b = 2.08 \pm 0.05$，与杂质电离饱和区预期 $b \approx 2$
相符，排除了明显的迁移率退化。”

**Hedges carry their scale.** 约、可能、相容、一致 are followed immediately by
the quantity that justifies them — an uncertainty, a ratio, a bound, or a
deviation from expectation.

**Bad:** “误差可能较大。”

**Good:** “该点残差 0.54%, 接近 0.55% 的剔除阈值, 予以保留并计入系统项.”

**Captions stay short.** One or two sentences: what is shown and its decisive
reading.

**Bad:** “图 3. 相位随反偏压的变化。测量在 1133 Hz 与 1633 Hz 两个频率下进行,
数据取自 D_1–D_5 的 0–10 V 扫描 (文件 phase_1133.csv 与 phase_1633.csv), 判据
见 4.1 节……”

**Good:** “图 3. 相位偏离随反偏压增大, 与串联损耗角模型 (式 11) 不符.”

**Anomalies close in one paragraph.** Observation, decisive check, limitation.

**Bad:** one paragraph excluding series resistance, one excluding parallel
leakage, one excluding deep levels, each with a reverse check and a numeric
bound — four paragraphs in total.

**Good:** “相位偏离与 $C_x$ 强线性相关, 但其频率标度与串联、并联模型均不符
(摆幅在频率增大 75% 时反降 13%), 列为未解释系统项; 对电容幅值的影响不超过
2.3%。”

## Define before formula

Define every variable and unit in the narrative before its first substantive
use; a connected derivation sequence may share a lead-in and interpretation.
Never leave a symbol used by a formula undefined.

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

实验中观察到的倍频曲线如\autoref{double-frequency}所示，透射率随所加直流
电压周期变化。

\begin{figure}[H]
  \centering
  \includegraphics[width=0.5\linewidth]{fig/倍频}
  \caption{未加样品与在电光晶体后放置云母片两种光路的倍频曲线；透射率极小值的间隔给出半波电压。}
  \label{double-frequency}
\end{figure}

未加样品以及在电光晶体后放置云母片时，由透射率极小值读出的直流偏压
$V_\text{D0}$ 与峰值电压 $V_\text{DP}$ 列于\autoref{double-frequency-table}。

\begin{table}[H]
  \centering
  \caption{两种光路的 $V_\text{D0}$ 与 $V_\text{DP}$ 测量值；两者之差给出半波电压。}
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
  \label{eq:half-wave}
\end{equation}

由\autoref{eq:half-wave}，晶体的电光系数为

\begin{equation}
  r_{63} = \frac{\lambda}{2 n_\text{o}^3 V_{\pi 2}} = 16.8\times10^{-10}\,\mathrm{cm/V}
  \label{eq:r63}
\end{equation}

其中 $V_{\pi 2} = 4V_\pi$ 为四块串联晶体的总半波电压，$\lambda = 632.8~\mathrm{nm}$
为激光波长，$n_\text{o}$ 为晶体寻常光折射率。
```

Points to note:

1. **Narrative first**: explanatory text introduces the figure and table
   before they appear, and prose separates the two elements.
2. **Variables defined before use**: $V_{\pi 2}$, $\lambda$, $n_\text{o}$ are
   defined where the formula that uses them is interpreted.
3. **Proper cross-references**: labelled equations referenced with
   `\autoref{}`; figures and tables likewise.
4. **Complete captions**: figure and table captions are self-explanatory.
5. **Results explained**: each numerical result is interpreted in context,
   once.

The same section in Typst (identical narrative shape; only the syntax
differs):

```typst
=== 倍频法

实验中观察到的倍频曲线如 @double-frequency 所示，透射率随所加直流电压周期
变化。

#figure(
  image("fig/倍频.png", width: 50%),
  caption: [未加样品与在电光晶体后放置云母片两种光路的倍频曲线；透射率极小值的间隔给出半波电压。],
) <double-frequency>

未加样品以及在电光晶体后放置云母片时，由透射率极小值读出的直流偏压
$V_"D0"$ 与峰值电压 $V_"DP"$ 列于 @double-frequency-table。

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
  caption: [两种光路的 $V_"D0"$ 与 $V_"DP"$ 测量值；两者之差给出半波电压。],
) <double-frequency-table>

因此，半波电压为

$ V_pi = V_"DP" - V_"D0" = 1375 "V" $ <eq:half-wave>

由 @eq:half-wave，晶体的电光系数为

$ r_63 = lambda / (2 n_o^3 V_(pi2)) = 16.8 times 10^(-10) "cm/V" $ <eq:r63>

其中 $V_(pi2) = 4 V_pi$ 为四块串联晶体的总半波电压，$lambda = 632.8 "nm"$ 为
激光波长，$n_o$ 为晶体寻常光折射率。
```

## Shared technical writing rules (upstream `common/writing.md`)

The topic-sentences section below applies to substantial persistent document
artifacts; brief chat answers and local lookups skip it.

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

## Final prose check

Before returning a document, search for and remove sentences whose only purpose
is to justify the writing process, source-search process, or avoidance of
hallucination. Delete a paragraph-final sentence that restates the paragraph
without adding a fact, limitation, or next step. Scan for contrastive
constructions and quotation marks wrapping paraphrases; retain them only when
they resolve a real ambiguity or carry reader-facing information. Apply the
keep-vs-cut test to every retained contrast.

## Evidence and citation contract (upstream `common/evidence-and-citations.md`)

These rules own source identity, claim-ledger, and citation policy for the
report; narrative style belongs to the shared technical writing rules above.

## Claim ledger contract

When a document makes source-dependent claims, maintain a compact working ledger
with one row per substantive claim:

```text
claim → evidence source → source location → evidence kind → confidence/boundary
```

The ledger records the allowed evidence kinds, source locations, version
scope, and unknown boundary decided for this report. It supports source review
and claim checks, but is not copied into reader-facing prose.

Use the strongest available primary source. Keep these identities distinct:

1. what a paper, handout, dataset, or other source states;
2. what an identified official implementation does;
3. a clearly labeled explanatory inference or simplification.

Third-party material may provide background or a comparison point when the
report's scope permits it; it does not upgrade an interpretation into a claim
made by the primary source. Official project material is a separate source
record unless the report's scope explicitly treats it as part of the source
scope.

Do not let a later code revision silently redefine a paper's evaluated method.
Do not create citations, bibliographic fields, data values, results, or source
locations. If a source does not establish an operational detail, omit it or
state the narrowest useful `not specified` boundary.

Treat source-specific operational disclosure as closed-world. A diagram arrow
or high-level verb establishes only the relation shown. Do not infer schemas,
defaults, state lifetimes, or failure paths. When a central question matters
but the sources are silent, retain the smallest useful `not specified`
boundary.

Place citations beside the claim they support. A citation must support the
nearest claim's scope, comparator, conditions, and strength; a broad method
citation does not prove an undisclosed API, default, state lifetime, filter, or
ranking rule.

Do not fabricate unavailable source identities, locations, APIs, configuration,
or implementation behavior. When source material is incomplete, use only its
disclosed algorithms, figures, appendices, and clearly labeled pseudocode.

## LaTeX format contract (upstream `formats/latex.md`)

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
  values stay comparable. Put units in the column header (`T (°C)`,
  `$V_"D0"$ / V`), not in every cell.
- Keep reusable style in scoped `#set`/`#show` rules. For Chinese body text,
  use `#set par(first-line-indent: (amount: 2em, all: true), justify: true)`
  and turn the indent off for outlines, bibliographies, lists, and tables.

## Document release gates (upstream `checks/document.md`)

These are deterministic release gates, not isolated reviewer roles. Run only
the sections whose trigger is active. The prose scan below detects violations
of the shared technical writing rules above; it does not add new style rules.

## For document artifacts: prose

Apply the shared technical writing rules above together with the editorial
contract and the active language guidance as a pass/fail gate. Pass only when
sections have clear purposes, paragraphs have
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
| It is important/worth noting that | 需要注意的是 / 值得一提的是 / 值得注意的是 |
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
claims from different primary sources and explanatory inferences visibly
separate. Remove invented results, citations, interfaces, state transitions,
defaults, formulas, and numerical details.

For experiments, trace every quantitative statement to measured or supplied
data. When the claim ledger is non-empty, use it to preserve source locations,
version scope, and uncertainty boundaries where the sources omit a behavior
needed to interpret the subject.

## If a rendered artifact exists: rendered document

Ensure the artifact is successfully compiled or rendered through the active
build workflow, then inspect the actual output. Check page breaks (chapter-like
titles start a page when the format requires it), first-line indent after
headings, heading gaps, orphaned headings, overflow, font fallback,
math, tables, figures, captions, cross-references, citation resolution, and
image readability. Correct the source and rerender until the observed artifact
matches the requested template and no material layout defect remains.
