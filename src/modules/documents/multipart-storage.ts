import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, HeadObjectCommand, S3Client, UploadPartCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export type MultipartPart = { partNumber: number; etag: string }
export class SupabaseMultipartStorage {
  private readonly client: S3Client
  constructor(private readonly config: { SUPABASE_S3_ENDPOINT?: string; SUPABASE_S3_ACCESS_KEY?: string; SUPABASE_S3_SECRET_KEY?: string; SUPABASE_S3_REGION?: string }) {
    if (!config.SUPABASE_S3_ENDPOINT || !config.SUPABASE_S3_ACCESS_KEY || !config.SUPABASE_S3_SECRET_KEY) throw new Error('S3_UPLOAD_NOT_CONFIGURED')
    this.client = new S3Client({ endpoint: config.SUPABASE_S3_ENDPOINT, region: config.SUPABASE_S3_REGION ?? 'local', forcePathStyle: true, credentials: { accessKeyId: config.SUPABASE_S3_ACCESS_KEY, secretAccessKey: config.SUPABASE_S3_SECRET_KEY } })
  }
  async initiate(bucket: string, key: string, contentType: string) { const result = await this.client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType })); if (!result.UploadId) throw new Error('S3_INIT_FAILED'); return result.UploadId }
  async signPart(bucket: string, key: string, uploadId: string, partNumber: number) { return getSignedUrl(this.client, new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: 900 }) }
  async head(bucket: string, key: string) { return this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })) }
  async complete(bucket: string, key: string, uploadId: string, parts: MultipartPart[]) { return this.client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts.sort((a,b) => a.partNumber - b.partNumber).map(p => ({ PartNumber: p.partNumber, ETag: p.etag })) } })) }
  async abort(bucket: string, key: string, uploadId: string) { await this.client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })) }
}
