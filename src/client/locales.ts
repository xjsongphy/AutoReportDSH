/** Locale bundles for the AutoReport plugin settings card. */

/** Locale keys this card renders. */
export type AutoReportLocaleKey =
  | 'title' | 'description'
  | 'overridden' | 'reset' | 'readOnly'
  | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed'
  | 'invalidChoice' | 'invalidNumber' | 'invalidPython'
  | 'reportLanguage' | 'reportLanguageHint'
  | 'timeoutMs' | 'timeoutMsHint'
  | 'python' | 'pythonHint'
  | 'pythonPick' | 'pythonManaged' | 'pythonCustom'
  | 'modelPicker' | 'modelPickerLoading' | 'modelPickerFailed' | 'reasoningEffort'
  | 'languageLatex' | 'languageTypst'

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
  invalidPython: 'Pick the AutoReport-managed venv, a detected local environment, or type an absolute interpreter path.',
  reportLanguage: 'Report language',
  reportLanguageHint: 'Source language for newly initialized workspaces.',
  timeoutMs: 'Delegation wait (ms)',
  timeoutMsHint: 'How long Main may wait when it delegates to a subagent with wait: true.',
  python: 'Python environment',
  pythonHint: 'Selecting AutoReport managed creates a uv venv under the DSH home and installs numpy, scipy, pandas, and matplotlib. It is not created until you choose it. Delete $DSH_HOME/autoreport/venv to reclaim space; choosing managed again recreates it. You can also pick a local conda/venv/pyenv/PATH interpreter or type a path. Subagent model, provider, and reasoning effort are switched in the conversation window.',
  pythonPick: 'Select an environment',
  pythonManaged: 'AutoReport managed venv',
  pythonCustom: 'Custom path…',
  modelPicker: 'Model',
  modelPickerLoading: 'Loading models…',
  modelPickerFailed: 'Could not load models for this subagent.',
  reasoningEffort: 'Reasoning effort',
  languageLatex: 'LaTeX',
  languageTypst: 'Typst',
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
  invalidPython: '请选择 AutoReport 托管环境、本机已检测的环境，或输入解释器的绝对路径。',
  reportLanguage: '报告语言',
  reportLanguageHint: '新初始化工作区使用的源码语言。',
  timeoutMs: '委派等待（毫秒）',
  timeoutMsHint: 'MAIN 以 wait: true 委派 subagent 时最多等待多久。',
  python: 'Python 环境',
  pythonHint: '选中 AutoReport 托管环境时才会用 uv 在 DSH home 下创建 venv 并安装 numpy/scipy/pandas/matplotlib。未选择不占空间。删除 $DSH_HOME/autoreport/venv 即可回收；再选托管会重新创建。也可选本机 conda/venv/pyenv/PATH 或自定义路径。subagent 的模型、提供方和推理力度请在对话窗口用 DSH 自己的切换。',
  pythonPick: '请选择环境',
  pythonManaged: 'AutoReport 托管环境',
  pythonCustom: '自定义路径…',
  modelPicker: '模型',
  modelPickerLoading: '正在加载模型…',
  modelPickerFailed: '无法加载这个 subagent 的模型列表。',
  reasoningEffort: '推理力度',
  languageLatex: 'LaTeX',
  languageTypst: 'Typst',
}
