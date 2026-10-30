# 模板使用说明（mplts 主题）

本文件随 `main.typ`、`mplts.typ` 一起初始化到 `Report/`。它只说明**本主题与模板**的版式约定；
Typst 语法本身见 `typst` skill。写作时先按本文件核对元素写法，再编译。

## 构建与文件

- 报告入口为 `Report/main.typ`；主题由 `#import "mplts.typ": *` 与
  `#show: mplts.with(font: "macos")` 启用。不要修改 `mplts.typ` 来修正入口文件的问题。
- 图片路径使用 `../Plots/Fig/...`；在 `Report/` 内编译，或以
  `typst compile main.typ --root ..` 让上级目录可解析。

## 表格（本主题最易出错）

- 表格必须写成：
  `#figure(kind: table, table(...), caption: [...]) <tab:name>`
  **`kind: table` 不能省略。** 主题只对 `kind: table` 设置“表”这个补充名与**表注在上**；
  省略 `kind` 时表格会按“图”编号、表注落到下方，正文里的 `@tab:name` 会显示成“图 N”。
- 表头用 `table.header(...)`，表头分隔用 `table.hline()`。主题自动提供首尾双线并去掉单元格网格，
  不要手工添加竖线或整表边线。
- 表注写在 `caption:` 中；正文先叙述再用 `表 @tab:name 列出…` 引用。

## 插图

- `#figure(image("../Plots/Fig/xxx.png", width: 78%), caption: [...]) <fig:name>`；图注在下。
- 同一测量的多面板图：把 `grid` 放进一个 `#figure`，面板标 `(a)`、`(b)`，共享一条图注；
  每个面板宽度取文本宽的 0.3–0.8。

## 交叉引用

- 元素标签前缀与类型一致：`fig:`、`tab:`、`eq:`。引用用 `@fig:name`、`@tab:name`、`@eq:name`，
  不要手写“图 3”“表 2”“式(1)”。
- 主题已把公式补充名设为“式”，引用时不要再写“式”字。

## 章节层级

- 一级标题用 `=`（引言、理论、实验装置与方法、结果与讨论、结论），二级用 `==`。
  理论是**一级节**，不要写成引言下的 `==`。
- 思考题放附录：`#start-appendix()` 后写 `= 思考题 <app:exercise>`，每道题以一个 `==` 小标题
  给出题目再写解答。

## 参考文献

- 位置：结论之后、附录之前，先 `#pagebreak()`，再
  `#bibliography-title[参考文献]` 与
  `#bibliography("bibli.bib", title: none, style: "american-physics-society.csl")`。
- 正文引用用 `#cite(<key>)`，key 必须存在于 `bibli.bib`；只列出正文引用过的文献，
  每条列出文献也应在正文有引用。

## 数值与数学写法

- 负值写入数学模式：`$-92 "V"$`，不要在正文用连字符代替负号。
- 同位素上标用 `#super[137]`（如 `#super[137]Cs`），不要使用 Unicode 上标字符（¹³⁷、⁵⁷）。
- 行内数学不留内侧空格（`$C_0$`）；独立公式用带空格的 `$ ... $`，并作为句子的一部分在末尾加标点。

## 标题区（frontmatter）

- 标题、摘要、关键词必填；作者、单位、日期保留占位（如“待填写”），除非用户提供了信息。
- 摘要约 200–300 字，概括方法、主要结果与结论，不使用第一人称。
