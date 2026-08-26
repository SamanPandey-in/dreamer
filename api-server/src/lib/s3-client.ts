import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { env } from './env';

// One S3 client for the lifetime of the process — same rationale as
// lib/prisma.ts: construct once, reuse everywhere, rather than paying
// connection/credential-resolution overhead per call.
//
// This talks to MinIO (docker-compose.yml), never real AWS S3 — MinIO
// just speaks the same S3 protocol, which is why @aws-sdk/client-s3 is
// still the right client. forcePathStyle is the one setting that
// actually matters for MinIO: it doesn't support virtual-hosted-style
// bucket addressing (`bucket.host/key`), only path-style
// (`host/bucket/key`).
export const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
  endpoint: env.S3_ENDPOINT_URL,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

/**
 * Deletes every object under a given prefix in MinIO. Used by
 * projects/project.service.ts's softDeleteProject to tear down a
 * project's live static output when it's deleted. Paginates
 * ListObjectsV2 and batches DeleteObjects in groups of up to 1000 keys
 * (the S3 API's own per-request limit — MinIO honors the same cap), so
 * this works whether the project had 3 files or 30,000.
 */
export async function deleteS3Prefix(prefix: string): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const listed = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: env.S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const keys = (listed.Contents ?? [])
      .map((obj) => ({ Key: obj.Key }))
      .filter((obj): obj is { Key: string } => Boolean(obj.Key));

    if (keys.length > 0) {
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: env.S3_BUCKET,
          Delete: { Objects: keys },
        })
      );
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}
