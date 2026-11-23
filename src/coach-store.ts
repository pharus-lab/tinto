// The writing coach's notes and the writer's solved and dismissed notes, kept on
// this computer per document, so they survive closing the document or Tinto.
// They are not part of the .tinto project. A damaged entry is ignored.
import { COACH_KINDS, type AnchoredNote } from './writing-coach'

export interface StoredNote { id: string; note: AnchoredNote; from: number; to: number; original: string; anchored: boolean; changed?: boolean; text: string }
export interface StoredCheck { notes: StoredNote[]; dropped: number; provider?: string; model?: string; reviewed?: string; stale: boolean }
export interface StoredResolved extends StoredNote { outcome: 'solved' | 'dismissed'; scope: string; at: string }

const prefix = (documentId: string) => 'tinto-coach:' + documentId + ':'
const RESOLVED = 'resolved'
const string = (value: unknown, limit = 2000) => typeof value === 'string' ? value.slice(0, limit) : ''
const position = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0

function note(value: Partial<StoredNote> | undefined): StoredNote | null {
  const n = value?.note as Partial<AnchoredNote> | undefined
  if (!value || !n || !COACH_KINDS.includes(n.kind as never) || typeof n.quote !== 'string') return null
  return {
    id: string(value.id, 64) || Math.random().toString(36).slice(2),
    note: { block: string(n.block, 150), quote: string(n.quote), kind: n.kind!, title: string(n.title, 600), explanation: string(n.explanation, 600), suggestion: string(n.suggestion, 600), repeat: n.repeat === true, from: position(n.from), to: position(n.to) },
    from: position(value.from), to: position(value.to), original: string(value.original), anchored: value.anchored === true, changed: value.changed === true, text: string(value.text)
  }
}
function read<T>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : null } catch { return null }
}
function write(key: string, value: unknown) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)) } catch { /* Keep editing if storage is full. */ }
}

export function loadCoach(documentId: string): { checks: [string, StoredCheck][]; resolved: StoredResolved[] } {
  const checks: [string, StoredCheck][] = []
  let keys: string[] = []
  try { keys = Object.keys(localStorage).filter(key => key.startsWith(prefix(documentId))) } catch { /* No storage. */ }
  for (const key of keys) {
    const scope = key.slice(prefix(documentId).length)
    if (scope === RESOLVED) continue
    const saved = read<Partial<StoredCheck>>(key)
    if (!saved || !Array.isArray(saved.notes)) continue
    checks.push([scope.replace(/^scope:/, ''), {
      notes: saved.notes.map(item => note(item)).filter((item): item is StoredNote => !!item),
      dropped: position(saved.dropped), provider: string(saved.provider, 100) || undefined, model: string(saved.model, 120) || undefined,
      reviewed: string(saved.reviewed, 40) || undefined, stale: saved.stale === true
    }])
  }
  const resolved = (read<Partial<StoredResolved>[]>(prefix(documentId) + RESOLVED) ?? []).flatMap(item => {
    const base = note(item)
    return base && (item.outcome === 'solved' || item.outcome === 'dismissed') ? [{ ...base, outcome: item.outcome, scope: string(item.scope, 150), at: string(item.at, 40) }] : []
  })
  return { checks, resolved: Array.isArray(resolved) ? resolved : [] }
}
export function saveCoachScope(documentId: string, scope: string, check: StoredCheck | null) { write(prefix(documentId) + 'scope:' + scope, check) }
export function saveCoachResolved(documentId: string, resolved: StoredResolved[]) { write(prefix(documentId) + RESOLVED, resolved.length ? resolved : null) }
export function clearCoach(documentId: string) {
  try { for (const key of Object.keys(localStorage)) if (key.startsWith(prefix(documentId))) localStorage.removeItem(key) } catch { /* No storage. */ }
}
