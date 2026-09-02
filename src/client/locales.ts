/** Locale bundles for the AutoReport plugin settings card. */

/** Locale keys this card renders. */
export type AutoReportLocaleKey =
  | 'title' | 'description'
  | 'overridden' | 'reset' | 'readOnly'
  | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed'
  | 'invalidChoice' | 'invalidNumber' | 'invalidPython'
  | 'reportLanguage' | 'reportLanguageHint'
  | 'idleTimeoutMs' | 'idleTimeoutMsHint' | 'timeoutMs' | 'timeoutMsHint'
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
  idleTimeoutMs: 'Delegation idle timeout (ms)',
  idleTimeoutMsHint: 'Main stops waiting after this much idle time. Model generation and tool execution do not count.',
  timeoutMs: 'Delegation maximum wait (ms)',
  timeoutMsHint: 'Absolute wait limit for Main when it delegates with wait: true, even while the subagent is active.',
  python: 'Python environment',
  pythonHint: 'Managed: creates a uv venv under the DSH home (numpy/scipy/pandas/matplotlib) once selected; delete $DSH_HOME/autoreport/venv to reclaim it. Local: uses a detected conda/venv/pyenv/PATH interpreter; packages are not auto-installed. Custom path: an absolute interpreter path.',
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
  idleTimeoutMs: '委派空闲超时（毫秒）',
  idleTimeoutMsHint: 'Subagent 连续空闲这么久后，MAIN 停止同步等待；生成模型回复和执行工具时不计时。',
  timeoutMs: '委派最长等待（毫秒）',
  timeoutMsHint: 'MAIN 以 wait: true 委派 subagent 时的绝对等待上限，即使 subagent 一直在工作也会到期。',
  python: 'Python 环境',
  pythonHint: '托管：选中后才在 DSH home 下用 uv 创建 venv（含 numpy/scipy/pandas/matplotlib），删除 $DSH_HOME/autoreport/venv 即可回收。本机：选用检测到的 conda/venv/pyenv/PATH 解释器，不自动装包。自定义路径：填解释器绝对路径。',
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
