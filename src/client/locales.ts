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
  | 'agentPicker'
  | 'languageLatex' | 'languageTypst'
  | 'mineru' | 'mineruHint' | 'mineruCommand' | 'mineruInstalled' | 'mineruNotInstalled'
  | 'mineruToken' | 'mineruTokenConfigured' | 'mineruTokenMissing'
  | 'mineruTokenSourceEnvironment' | 'mineruTokenSourceConfig'

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
  idleTimeoutMsHint: 'Main ends the synchronous wait after the subagent has been inactive for this duration. Model generation and tool execution are excluded.',
  timeoutMs: 'Delegation maximum wait (ms)',
  timeoutMsHint: 'Absolute limit for Main synchronous waits initiated with wait: true. It applies regardless of subagent activity.',
  python: 'Python environment',
  pythonHint: 'Managed creates the required Python environment. Local uses a detected interpreter; custom path accepts an absolute interpreter path.',
  pythonPick: 'Select an environment',
  pythonManaged: 'AutoReport managed venv',
  pythonCustom: 'Custom path…',
  modelPicker: 'Model',
  modelPickerLoading: 'Loading models…',
  modelPickerFailed: 'Could not load models for this subagent.',
  reasoningEffort: 'Reasoning effort',
  agentPicker: 'AutoReport subagent',
  languageLatex: 'LaTeX',
  languageTypst: 'Typst',
  mineru: 'MinerU',
  mineruHint: 'Used by MAIN for precise PDF extraction with mineru-open-api. Status is checked when DSH starts.',
  mineruCommand: 'CLI',
  mineruInstalled: 'Installed',
  mineruNotInstalled: 'Not installed',
  mineruToken: 'API token',
  mineruTokenConfigured: 'Configured',
  mineruTokenMissing: 'Not configured',
  mineruTokenSourceEnvironment: 'Environment variable',
  mineruTokenSourceConfig: 'Config file',
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
  idleTimeoutMsHint: 'Subagent 无可观测活动持续达到此时长后，MAIN 将结束同步等待；模型生成与工具执行期间不计入。',
  timeoutMs: '委派绝对等待上限（毫秒）',
  timeoutMsHint: 'MAIN 使用 wait: true 发起委派时的同步等待上限；达到上限后结束等待，不受 Subagent 活动状态影响。',
  python: 'Python 环境',
  pythonHint: '托管环境会创建所需的 Python 环境；本机环境使用已检测到的解释器；也可指定解释器绝对路径。',
  pythonPick: '请选择环境',
  pythonManaged: 'AutoReport 托管环境',
  pythonCustom: '自定义路径…',
  modelPicker: '模型',
  modelPickerLoading: '正在加载模型…',
  modelPickerFailed: '无法加载这个 subagent 的模型列表。',
  reasoningEffort: '推理力度',
  agentPicker: 'AutoReport subagent',
  languageLatex: 'LaTeX',
  languageTypst: 'Typst',
  mineru: 'MinerU',
  mineruHint: 'MAIN 使用 mineru-open-api 做精确 PDF 提取；状态在 DSH 启动时检测。',
  mineruCommand: '命令',
  mineruInstalled: '已安装',
  mineruNotInstalled: '未安装',
  mineruToken: 'API Token',
  mineruTokenConfigured: '已配置',
  mineruTokenMissing: '未配置',
  mineruTokenSourceEnvironment: '环境变量',
  mineruTokenSourceConfig: '配置文件',
}
