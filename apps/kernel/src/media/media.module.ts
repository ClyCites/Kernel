import { Module, type OnApplicationShutdown } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { RecordsModule } from '../records/records.module.js';
import { MediaRepository } from './media.repository.js';
import { MediaService } from './media.service.js';
import { OBJECT_STORE, ObjectStore } from './objects.js';

/**
 * The object store is optional at wiring time.
 *
 * A kernel with no store configured must still start and still serve every
 * endpoint that does not touch bytes — the media module is one deployment
 * concern among twelve, and a missing bucket credential should not take the
 * consent module down with it. {@link MediaService} answers 503 rather than
 * pretending, and `configured` says which it is.
 *
 * The environment is read directly here rather than through `loadConfig()`,
 * for the same reason the training module does: this factory runs during
 * module construction in every test that builds a Nest app, most of which
 * have no reason to hold a complete environment.
 */
function storeFromEnvironment(): ObjectStore | null {
  const endpoint = process.env['MEDIA_S3_ENDPOINT'];
  const bucket = process.env['MEDIA_S3_BUCKET'];
  const accessKeyId = process.env['MEDIA_S3_ACCESS_KEY'];
  const secretAccessKey = process.env['MEDIA_S3_SECRET_KEY'];

  if (
    endpoint === undefined || endpoint === '' ||
    bucket === undefined || bucket === '' ||
    accessKeyId === undefined || accessKeyId === '' ||
    secretAccessKey === undefined || secretAccessKey === ''
  ) {
    return null;
  }

  return new ObjectStore({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env['MEDIA_S3_REGION'] ?? 'us-east-1',
    forcePathStyle: process.env['MEDIA_S3_PATH_STYLE'] !== 'false',
  });
}

@Module({
  imports: [RecordsModule, AuditModule],
  providers: [
    MediaRepository,
    MediaService,
    { provide: OBJECT_STORE, useFactory: storeFromEnvironment },
  ],
  exports: [MediaRepository, MediaService],
})
export class MediaModule implements OnApplicationShutdown {
  onApplicationShutdown(): void {
    // The S3 client holds keep-alive sockets. Nothing to close explicitly in
    // the v3 client beyond letting it go, but the hook is here so that a
    // future store with a real connection pool has somewhere to be closed.
  }
}
