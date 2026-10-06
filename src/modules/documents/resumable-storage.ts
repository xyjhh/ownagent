export type ProviderUploadStatus = 'uploading' | 'completed' | 'aborted'

export interface ResumableStorage {
  initiate(input: { bucket: string; key: string; contentType: string; size: number }): Promise<{ providerUploadId: string; uploadUrl: string; offset: number; uploadHeaders: Record<string, string> }>
  getStatus(input: { bucket: string; key: string; providerUploadId: string }): Promise<{ offset: number; size: number; status: ProviderUploadStatus }>
  complete(input: { bucket: string; key: string; providerUploadId: string }): Promise<{ etag?: string; size: number }>
  abort(input: { bucket: string; key: string; providerUploadId: string }): Promise<void>
}

export class SupabaseResumableStorage implements ResumableStorage {
  private readonly base: string
  private readonly token: string
  constructor(private readonly config: { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; SUPABASE_STORAGE_UPLOAD_TOKEN?: string }) {
    this.base = `${config.SUPABASE_URL.replace(/\/$/, '')}/storage/v1`
    this.token = config.SUPABASE_STORAGE_UPLOAD_TOKEN ?? ''
    if (this.token && this.token === config.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('STORAGE_UPLOAD_TOKEN_MUST_NOT_BE_SERVICE_ROLE_KEY')
    }
  }
  private headers(extra: Record<string, string> = {}) { return { Authorization: `Bearer ${this.token}`, ...extra } }
  resumeDetails(providerUploadId: string) { return { uploadUrl: `${this.base}/upload/resumable/${encodeURIComponent(providerUploadId)}`, uploadHeaders: this.headers({ 'Tus-Resumable': '1.0.0' }) } }
  async initiate(input: { bucket: string; key: string; contentType: string; size: number }) {
    if (!this.token) throw new Error('STORAGE_UPLOAD_TOKEN_NOT_CONFIGURED')
    const metadata = `bucketName ${btoa(input.bucket)},objectName ${btoa(input.key)},contentType ${btoa(input.contentType)}`
    const response = await fetch(`${this.base}/upload/resumable`, { method: 'POST', headers: this.headers({ 'Tus-Resumable': '1.0.0', 'Upload-Length': String(input.size), 'Upload-Metadata': metadata, 'x-upsert': 'false' }) })
    if (!response.ok) throw new Error(`STORAGE_INIT_FAILED:${response.status}`)
    const location = response.headers.get('location') ?? response.headers.get('Location')
    if (!location) throw new Error('STORAGE_INIT_MISSING_LOCATION')
    const providerUploadId = location.split('/').pop() ?? location
    return { providerUploadId, uploadUrl: new URL(location, this.base).toString(), offset: Number(response.headers.get('Upload-Offset') ?? 0), uploadHeaders: this.headers({ 'Tus-Resumable': '1.0.0' }) }
  }
  async getStatus(input: { bucket: string; key: string; providerUploadId: string }) {
    const url = `${this.base}/upload/resumable/${encodeURIComponent(input.providerUploadId)}`
    const response = await fetch(url, { method: 'HEAD', headers: this.headers({ 'Tus-Resumable': '1.0.0' }) })
    if (response.status === 404) return { offset: 0, size: 0, status: 'aborted' as const }
    if (!response.ok) throw new Error(`STORAGE_STATUS_FAILED:${response.status}`)
    const offset = Number(response.headers.get('Upload-Offset') ?? 0)
    const size = Number(response.headers.get('Upload-Length') ?? 0)
    const completed = response.headers.get('Upload-Complete') === 'true' || (size > 0 && offset >= size)
    return { offset, size, status: completed ? 'completed' as const : 'uploading' as const }
  }
  async complete(input: { bucket: string; key: string; providerUploadId: string }) {
    const status = await this.getStatus(input)
    if (status.status !== 'completed') throw new Error('STORAGE_UPLOAD_INCOMPLETE')
    return { size: status.size }
  }
  async abort(input: { bucket: string; key: string; providerUploadId: string }) {
    const response = await fetch(`${this.base}/upload/resumable/${encodeURIComponent(input.providerUploadId)}`, { method: 'DELETE', headers: this.headers({ 'Tus-Resumable': '1.0.0' }) })
    if (!response.ok && response.status !== 404) throw new Error(`STORAGE_ABORT_FAILED:${response.status}`)
  }
}
