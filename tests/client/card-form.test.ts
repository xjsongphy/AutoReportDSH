import { describe, expect, it } from 'vitest'
import { CardForm, enumField, numberField, textField } from '../../src/client/card-form.js'
import { AutoReportCardController, type AutoReportCardSettings } from '../../src/client/controller.js'
import { acceptWrites, stubSettingsScope } from './stub-scope.js'

function form() {
  const host = stubSettingsScope<Record<string, unknown>>()
  const subject = new CardForm(host.scope, [
    numberField('delegationWaitTimeoutMs'),
    enumField('defaultReportLanguage', ['latex', 'typst']),
    textField('pythonExecutable'),
    textField('specialistModel.provider'),
    textField('specialistModel.model'),
    textField('specialistModel.reasoningEffort'),
  ])
  host.publish({
    status: 'ready',
    writable: true,
    value: { delegationWaitTimeoutMs: 600_000, defaultReportLanguage: 'latex' },
    base: { delegationWaitTimeoutMs: 600_000, defaultReportLanguage: 'latex' },
    user: {},
  })
  return { host, subject }
}

describe('CardForm', () => {
  it('shows the effective value and stays clean until something is staged', () => {
    const { subject } = form()

    expect(subject.field('delegationWaitTimeoutMs')).toEqual({ text: '600000', overridden: false, invalid: false })
    expect(subject.shell()).toMatchObject({ available: true, writable: true, dirty: false, invalid: false })
  })

  it('writes nothing until the form is saved', async () => {
    const { host, subject } = form()
    acceptWrites(host)

    subject.actions().edit('delegationWaitTimeoutMs', '9000')

    expect(subject.field('delegationWaitTimeoutMs')).toEqual({ text: '9000', overridden: true, invalid: false })
    expect(subject.shell().dirty).toBe(true)
    expect(host.set).not.toHaveBeenCalled()

    await subject.save()

    expect(host.set.mock.calls).toEqual([['delegationWaitTimeoutMs', 9_000]])
    expect(subject.shell()).toMatchObject({ dirty: false, failed: false, saving: false })
  })

  it('refuses a non-positive timeout and keeps the draft', async () => {
    const { host, subject } = form()

    subject.actions().edit('delegationWaitTimeoutMs', 'soon')

    expect(subject.field('delegationWaitTimeoutMs').invalid).toBe(true)
    expect(subject.shell()).toMatchObject({ dirty: true, invalid: true })

    await subject.save()

    expect(host.set).not.toHaveBeenCalled()
    expect(subject.field('delegationWaitTimeoutMs').text).toBe('soon')
  })

  it('clears an overridden field on reset once saved', async () => {
    const { host, subject } = form()
    acceptWrites(host)
    host.publish({
      value: { delegationWaitTimeoutMs: 9_000, defaultReportLanguage: 'latex' },
      user: { delegationWaitTimeoutMs: 9_000 },
    })

    subject.actions().resetField('delegationWaitTimeoutMs')
    expect(subject.field('delegationWaitTimeoutMs').overridden).toBe(false)
    expect(host.unset).not.toHaveBeenCalled()

    await subject.save()

    expect(host.unset.mock.calls).toEqual([['delegationWaitTimeoutMs']])
  })

  it('writes a specialist route as one parent object', async () => {
    const { host, subject } = form()
    acceptWrites(host)

    subject.actions().edit('specialistModel.provider', 'openai-codex')
    subject.actions().edit('specialistModel.model', 'gpt-5.6')
    subject.actions().edit('specialistModel.reasoningEffort', 'high')

    await subject.save()

    expect(host.set.mock.calls).toEqual([['specialistModel', {
      provider: 'openai-codex',
      model: 'gpt-5.6',
      reasoningEffort: 'high',
    }]])
  })

  it('refuses a specialist route that is missing the model', async () => {
    const { host, subject } = form()

    subject.actions().edit('specialistModel.provider', 'openai-codex')

    expect(subject.shell()).toMatchObject({ dirty: true, invalid: true })
    await subject.save()
    expect(host.set).not.toHaveBeenCalled()
  })

  it('clears the specialist route back to inherit-Main', async () => {
    const { host, subject } = form()
    acceptWrites(host)
    host.publish({
      value: {
        delegationWaitTimeoutMs: 600_000,
        defaultReportLanguage: 'latex',
        specialistModel: { provider: 'openai-codex', model: 'gpt-5.6' },
      },
      user: { specialistModel: { provider: 'openai-codex', model: 'gpt-5.6' } },
    })

    subject.actions().resetField('specialistModel.provider')
    await subject.save()

    expect(host.unset.mock.calls).toEqual([['specialistModel']])
  })
})

describe('AutoReportCardController', () => {
  it('keys the injected snapshot on the autoreport namespace fields', () => {
    const host = stubSettingsScope<AutoReportCardSettings>()
    const subject = new AutoReportCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { defaultReportLanguage: 'typst', delegationWaitTimeoutMs: 1_000 },
      base: { defaultReportLanguage: 'latex', delegationWaitTimeoutMs: 600_000 },
      user: { defaultReportLanguage: 'typst' },
    })

    const face = subject.inject()
    const state = face.hooks.autoreportCard.getSnapshot()
    expect(state.available).toBe(true)
    expect(state.defaultReportLanguage).toEqual({ text: 'typst', overridden: true, invalid: false })
    expect(Object.keys(face.hooks)).toEqual(['autoreportCard'])
  })

  it('treats a typed relative Python path as invalid and a detected path as valid', () => {
    const host = stubSettingsScope<AutoReportCardSettings>()
    const subject = new AutoReportCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: {
        pythonEnvironments: [{
          label: 'Workspace venv · Python 3.12',
          executable: '/opt/venv/bin/python3',
          source: 'virtualenv',
          version: 'Python 3.12.0',
        }],
      },
      base: {},
      user: {},
    })
    const face = subject.inject()
    face.edit('pythonExecutable', 'python3')
    expect(face.hooks.autoreportCard.getSnapshot().pythonExecutable.invalid).toBe(true)
    face.edit('pythonExecutable', '/opt/venv/bin/python3')
    const state = face.hooks.autoreportCard.getSnapshot()
    expect(state.pythonExecutable.invalid).toBe(false)
    expect(state.pythonEnvironments).toHaveLength(1)
    face.edit('pythonExecutable', '__managed__')
    expect(face.hooks.autoreportCard.getSnapshot().pythonExecutable.invalid).toBe(false)
  })
})
