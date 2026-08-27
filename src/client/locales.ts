/** Locale bundles for the AutoReport plugin settings card. */

/** Locale keys this card renders. */
export type AutoReportLocaleKey =
  | 'title' | 'description'
  | 'overridden' | 'reset' | 'readOnly'
  | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed'
  | 'invalidChoice' | 'invalidNumber' | 'invalidRoute'
  | 'reportLanguage' | 'reportLanguageHint'
  | 'latexEngine' | 'latexEngineHint'
  | 'timeoutMs' | 'timeoutMsHint'
  | 'python' | 'pythonHint'
  | 'specialistProvider' | 'specialistProviderHint'
  | 'specialistModel' | 'specialistModelHint'
  | 'specialistEffort' | 'specialistEffortHint'
  | 'languageLatex' | 'languageTypst'
  | 'engineLatexmk' | 'engineTectonic'

/** English copy. */
export const en: Record<AutoReportLocaleKey, string> = {
  title: 'AutoReport',
  description: 'Defaults for new physics-report workflows. Changing these does not alter a report that is already running.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidChoice: 'Choose one of the listed options.',
  invalidNumber: 'Enter a positive whole number, or leave blank to use the default.',
  invalidRoute: 'Provide both a provider and a model, or leave both blank to inherit Main.',
  reportLanguage: 'Report language',
  reportLanguageHint: 'Source language for newly initialized workspaces.',
  latexEngine: 'LaTeX engine',
  latexEngineHint: 'Compiler used when the report language is LaTeX.',
  timeoutMs: 'Delegation wait (ms)',
  timeoutMsHint: 'How long Main may wait for a specialist that was sent with wait: true.',
  python: 'Python interpreter',
  pythonHint: 'Optional absolute path for specialist bash. Leave blank to use the environment default.',
  specialistProvider: 'Specialist provider',
  specialistProviderHint: 'DSH provider id for every specialist. Leave blank to inherit Main.',
  specialistModel: 'Specialist model',
  specialistModelHint: 'Model id for that provider. Required when a provider is set.',
  specialistEffort: 'Specialist reasoning effort',
  specialistEffortHint: 'Optional adapter-owned effort. Leave blank for the provider default.',
  languageLatex: 'LaTeX',
  languageTypst: 'Typst',
  engineLatexmk: 'latexmk',
  engineTectonic: 'Tectonic',
}

/** Simplified Chinese copy. */
export const zh: Record<AutoReportLocaleKey, string> = {
  title: 'AutoReport',
  description: '新报告工作流的默认值。修改后不会影响已经在跑的报告。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidChoice: '请选择列表中的一项。',
  invalidNumber: '请填正整数；留空表示使用默认值。',
  invalidRoute: 'provider 和 model 需要一起填写，或都留空以继承 MAIN。',
  reportLanguage: '报告语言',
  reportLanguageHint: '新初始化工作区使用的源码语言。',
  latexEngine: 'LaTeX 引擎',
  latexEngineHint: '报告语言为 LaTeX 时使用的编译器。',
  timeoutMs: '委派等待（毫秒）',
  timeoutMsHint: 'MAIN 以 wait: true 委派 specialist 时最多等待多久。',
  python: 'Python 解释器',
  pythonHint: 'specialist bash 使用的可选绝对路径。留空则使用环境默认。',
  specialistProvider: 'Specialist 提供方',
  specialistProviderHint: '所有 specialist 使用的 DSH provider id。留空则继承 MAIN。',
  specialistModel: 'Specialist 模型',
  specialistModelHint: '该提供方下的模型 id。填写了提供方时必填。',
  specialistEffort: 'Specialist 推理力度',
  specialistEffortHint: '可选，由适配器解释。留空则使用提供方默认。',
  languageLatex: 'LaTeX',
  languageTypst: 'Typst',
  engineLatexmk: 'latexmk',
  engineTectonic: 'Tectonic',
}
