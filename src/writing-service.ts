import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { validateWritingRequest, type WritingResponse } from './writing-types'

export class WritingService {
  private worker?: Worker
  private nextId = 0
  private pending = new Map<number, { resolve: (value: WritingResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(private assets: string) {}

  check(input: unknown): Promise<WritingResponse> {
    const request = validateWritingRequest(input)
    if (this.pending.size >= 32) return Promise.reject(Error('Writing checks are busy. Try again.'))
    if (!this.worker) {
      const worker = this.worker = new Worker(join(this.assets, 'writing-worker.cjs'), { workerData: { assets: this.assets } })
      worker.on('message', ({ id, result, error }) => {
        const job = this.pending.get(id)
        if (!job) return
        clearTimeout(job.timer)
        this.pending.delete(id)
        if (!this.pending.size) worker.unref()
        if (error) job.reject(Error(error))
        else job.resolve(result)
      })
      worker.on('error', () => { if (this.worker === worker) this.stop() })
      worker.on('exit', () => { if (this.worker === worker) this.stop() })
      worker.unref()
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => this.stop(), 45_000)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      this.worker!.ref()
      this.worker!.postMessage({ id, request })
    })
  }
  stop() {
    const worker = this.worker
    this.worker = undefined
    if (worker) void worker.terminate()
    for (const job of this.pending.values()) {
      clearTimeout(job.timer)
      job.reject(Error('Writing checks are unavailable. Try again.'))
    }
    this.pending.clear()
  }
}
