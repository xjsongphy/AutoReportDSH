/** Web role navigator for AutoReport's resident MAIN and subagent sessions. */

import { useEffect, useMemo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISessions, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import { SelectMenu } from './SelectMenu.js'
import { css } from './styles.js'

const AUTO_REPORT_PRESETS = new Set(['autoreport', 'autoreport-main'])
const ROLE_NAMES = ['THEORY', 'DATA_ANALYSIS', 'PLOTTING', 'REPORT'] as const
type RoleName = typeof ROLE_NAMES[number]

interface RoleOption {
  readonly id: SessionId
  readonly label: string
  readonly role: 'MAIN' | RoleName
  readonly address?: SubagentAddress
}

export type ResidentRoleSelectProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'settings.autoreport'>
  & { sessions: ISessions }

function roleFromLabel(label: string | undefined): RoleName | undefined {
  if (label === undefined) return undefined
  const role = label.replace(/^AutoReport\s+/u, '')
  return (ROLE_NAMES as readonly string[]).includes(role) ? role as RoleName : undefined
}

function rootIdFor(sessionId: SessionId, list: SessionListState, sessions: ISessions): SessionId | undefined {
  const address = sessions.subagentAddress(sessionId)
  if (address !== undefined) return address.parentSessionId
  const summary = list.byId[sessionId]
  if (summary?.parentId !== undefined) return summary.parentId
  return AUTO_REPORT_PRESETS.has(summary?.agentPreset ?? '') ? sessionId : undefined
}

function optionsFor(rootId: SessionId, list: SessionListState): RoleOption[] {
  const options: RoleOption[] = [{ id: rootId, role: 'MAIN', label: 'MAIN' }]
  const catalog = list.subagentsByParent[rootId] as unknown as { entries?: readonly {
    kind: string
    id: SessionId
    mode?: string
    label?: string
  }[] } | undefined
  for (const entry of catalog?.entries ?? []) {
    if (entry.kind !== 'child' || entry.mode !== 'continuable') continue
    const role = roleFromLabel(entry.label)
    if (role === undefined) continue
    options.push({
      id: entry.id,
      role,
      label: role,
      address: { parentSessionId: rootId, childSessionId: entry.id, mode: entry.mode },
    })
  }
  return options
}

function currentRole(sessionId: SessionId, rootId: SessionId, options: readonly RoleOption[]): string {
  if (sessionId === rootId) return 'MAIN'
  return options.find(option => option.id === sessionId)?.role ?? 'SUBAGENT'
}

/** Switch the visible conversation between the five resident AutoReport roles. */
export function ResidentRoleSelect({ sessionId, useSessions, sessions, t }: ResidentRoleSelectProps) {
  const list = useSessions(state => state)
  const rootId = rootIdFor(sessionId, list, sessions)
  const catalogState = rootId === undefined ? undefined : list.subagentsByParent[rootId]?.state

  useEffect(() => {
    if (rootId === undefined || catalogState !== undefined) return
    void sessions.refreshSubagents(rootId)
  }, [catalogState, rootId, sessions])

  const options = useMemo(
    () => rootId === undefined ? [] : optionsFor(rootId, list),
    [list, rootId, sessions],
  )
  if (rootId === undefined || options.length <= 1) return null

  const selected = currentRole(sessionId, rootId, options)
  return (
    <div className={css.rolePicker} title={t('agentPicker')}>
      <span className={css.rolePickerLabel}>{t('agentPicker')}</span>
      <SelectMenu
        id="autoreport-role-picker"
        ariaLabel={t('agentPicker')}
        variant="chip"
        side="bottom"
        align="end"
        value={selected}
        options={options.map(option => ({ value: option.role, label: option.label }))}
        onChange={value => {
          const option = options.find(candidate => candidate.role === value)
          if (option === undefined) return
          if (option.role === 'MAIN') sessions.open(rootId)
          else if (option.address !== undefined) sessions.openSubagent(option.address)
        }}
      />
    </div>
  )
}
