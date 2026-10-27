import { afterEach, describe, expect, it, vi } from 'vitest'
import { SupabaseMultipartStorage } from '../src/modules/documents/multipart-storage.js'
import { SupabaseResumableStorage } from '../src/modules/documents/resumable-storage.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('public upload URLs', () => {
  it('returns TUS URLs on the public origin while creating the upload internally', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 201,
        headers: {
          location: 'http://kong:8000/storage/v1/upload/resumable/upload-123?token=abc',
          'Upload-Offset': '0',
        },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const storage = new SupabaseResumableStorage({
      SUPABASE_URL: 'http://kong:8000',
      SUPABASE_PUBLIC_URL: 'https://agent.example.com',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      SUPABASE_STORAGE_UPLOAD_TOKEN: 'upload-token',
    })

    const upload = await storage.initiate({
      bucket: 'knowledge-documents',
      key: 'workspace/document.txt',
      contentType: 'text/plain',
      size: 12,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://kong:8000/storage/v1/upload/resumable',
      expect.any(Object)
    )
    expect(upload.uploadUrl).toBe(
      'https://agent.example.com/storage/v1/upload/resumable/upload-123?token=abc'
    )
  })

  it('returns resume URLs on the public origin', () => {
    const storage = new SupabaseResumableStorage({
      SUPABASE_URL: 'http://kong:8000',
      SUPABASE_PUBLIC_URL: 'https://agent.example.com',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      SUPABASE_STORAGE_UPLOAD_TOKEN: 'upload-token',
    })

    expect(storage.resumeDetails('upload-123').uploadUrl).toBe(
      'https://agent.example.com/storage/v1/upload/resumable/upload-123'
    )
  })

  it('signs multipart part URLs for the public endpoint', async () => {
    const storage = new SupabaseMultipartStorage({
      SUPABASE_S3_ENDPOINT: 'http://kong:8000/storage/v1/s3',
      SUPABASE_S3_PUBLIC_ENDPOINT: 'https://agent.example.com/storage/v1/s3',
      SUPABASE_S3_ACCESS_KEY: 'access-key',
      SUPABASE_S3_SECRET_KEY: 'secret-key',
      SUPABASE_S3_REGION: 'local',
    })

    const url = new URL(await storage.signPart('knowledge-documents', 'file.txt', 'upload-1', 1))

    expect(url.origin).toBe('https://agent.example.com')
    expect(url.pathname).toContain('/storage/v1/s3/knowledge-documents/file.txt')
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
  })
})
