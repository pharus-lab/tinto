import { button, element } from './ui'

export function backupSettings(parent: HTMLElement, flush: () => boolean, restored: (workspace: Awaited<ReturnType<typeof window.tinto.workspace>>) => void) {
  const section = element('section', 'backup-settings')
  section.append(element('h3', 'group-label', 'Google Drive backup'))
  parent.append(section)
  const actions = element('div', 'home-actions')
  const message = element('p')
  message.setAttribute('role', 'status')
  section.append(actions, message)
  function failure(error: unknown) { message.textContent = error instanceof Error ? error.message : String(error) }
  async function refresh() {
    const api = window.tinto
    const state = await api.backupStatus()
    actions.replaceChildren()
    function action(title: string, task: () => Promise<void>) {
      const control = button(title, async () => {
        actions.querySelectorAll('button').forEach(el => el.disabled = true)
        message.textContent = title + '…'
        try { await task() } catch (error) { failure(error) }
        finally { actions.querySelectorAll('button').forEach(el => el.disabled = false) }
      }, 'outline')
      actions.append(control)
    }
    if (!state.connected) {
      message.textContent = 'Connect with a Google desktop client JSON file to back up this project every 15 minutes when it changes.'
      action('Connect Google Drive', async () => { if (flush()) await api.connectDrive(); await refresh() })
      return
    }
    const date = state.lastSuccess ? new Date(state.lastSuccess).toLocaleString() : 'No successful backup yet'
    message.textContent = state.error ?? 'Last successful backup · ' + date
    action(state.enabled ? 'Pause automatic backups' : 'Enable project backups', async () => { await api.enableBackup(!state.enabled); await refresh() })
    action('Back up now', async () => { if (flush()) await api.backUp(); await refresh() })
    action('Restore backup', async () => {
      const versions = await api.backupList()
      if (!versions.length) { message.textContent = 'There are no backups to restore.'; return }
      const select = element('select')
      select.setAttribute('aria-label', 'Project backup')
      for (const v of versions) select.add(new Option(v.name + ' · ' + new Date(v.time).toLocaleString(), v.id))
      actions.replaceChildren(select)
      message.textContent = 'Choose a backup and save it as a new project file.'
      action('Restore to file…', async () => {
        if (!flush()) return
        const result = await api.restoreBackup(select.value)
        if (result) restored(result)
      })
      action('Cancel', refresh)
    })
    action('Disconnect', async () => { await api.disconnectDrive(); await refresh() })
  }
  void refresh().catch(failure)
}
