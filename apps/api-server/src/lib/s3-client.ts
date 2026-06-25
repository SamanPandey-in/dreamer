import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { env } from './env';

// One S3 client for the lifetime of the process — same rationale as
// lib/ecs-client.ts and lib/prisma.ts: construct once, reuse everywhere,
// rather than paying connection/credential-resolution overhead per call.
export const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
  },
});

/**
 * Deletes every object under a given S3 prefix. Used by
 * projects/project.service.ts's softDeleteProject to tear down a project's
 * live output when it's deleted. Paginates ListObjectsV2 and batches
 * DeleteObjects in groups of up to 1000 keys (S3's own per-request limit),
 * so this works whether the project had 3 files or 30,000.
 *
 * No-ops cleanly (with a warning, not a throw) if S3_BUCKET was never
 * configured — a local/dev setup that hasn't wired up AWS at all shouldn't
 * have project deletion fail on it for a feature (live S3 hosting) it was
 * never using to begin with.
 */
export async function deleteS3Prefix(prefix: string): Promise<void> {
  if (!env.S3_BUCKET) {
    console.warn('[S3] S3_BUCKET is not configured — skipping S3 cleanup for prefix', prefix);
    return;
  }

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
