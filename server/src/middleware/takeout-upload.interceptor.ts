import { BadRequestException, CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { transformException } from '@nestjs/platform-express/multer/multer/multer.utils';
import { NextFunction } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Observable } from 'rxjs';
import sanitize from 'sanitize-filename';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder } from 'src/enum.js';
import { AuthRequest } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { getFilenameExtension } from 'src/utils/file.js';

/**
 * Maximum accepted archive upload size (64 GiB). Takeout archives are split by Google
 * into chunks of at most 50 GB, so this comfortably covers a single archive.
 */
export const TAKEOUT_MAX_ARCHIVE_SIZE = 64 * 1024 * 1024 * 1024;

export const TAKEOUT_UPLOAD_FIELD = 'file';

const TAKEOUT_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tgz', '.gz'];

/**
 * Multer-based interceptor that streams the uploaded Takeout archive to a staging
 * folder inside the user's upload directory. The archive is not hashed or ingested
 * here — the import job reads it and removes it when done.
 *
 * A dedicated interceptor (rather than `FileUploadInterceptor`) is used because
 * that interceptor only supports the asset upload and user profile routes.
 */
@Injectable()
export class TakeoutUploadInterceptor implements NestInterceptor {
  private handler: ReturnType<typeof multer>;

  constructor(
    private storageRepository: StorageRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(TakeoutUploadInterceptor.name);

    this.handler = multer({
      storage: multer.diskStorage({
        filename: (_request, file, callback) => {
          const extension = sanitize(getFilenameExtension(file.originalname));
          callback(null, `${randomUUID()}${extension}`);
        },
        destination: (request: AuthRequest, _file, callback) => {
          try {
            const ownerId = request.user?.user.id;
            if (!ownerId) {
              callback(new BadRequestException('Missing authenticated user'), '');
              return;
            }
            const folder = join(StorageCore.getFolderLocation(StorageFolder.Upload, ownerId), 'takeout');
            this.storageRepository.mkdirSync(folder);
            callback(null, folder);
          } catch (error) {
            callback(error as Error, '');
          }
        },
      }),
      fileFilter: (_request, file, callback) => {
        if (!this.isSupportedFileName(file.originalname)) {
          const safeName = sanitize(Buffer.from(file.originalname, 'latin1').toString('utf8')) || 'upload';
          return callback(
            new BadRequestException(`Invalid file name '${safeName}', expected a .zip, .tar or .tar.gz archive`),
          );
        }
        callback(null, true);
      },
      limits: {
        fileSize: TAKEOUT_MAX_ARCHIVE_SIZE,
        files: 1,
        parts: 2,
        fields: 1,
        fieldSize: 64 * 1024,
      },
    });
  }

  private isSupportedFileName(name: string): boolean {
    const lower = name.toLowerCase();
    return TAKEOUT_ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension));
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const context_ = context.switchToHttp();
    const request = context_.getRequest<AuthRequest>();

    await new Promise<void>((resolve, reject) => {
      const done: NextFunction = (error) => (error ? reject(transformException(error)) : resolve());
      Promise.resolve(this.handler.single(TAKEOUT_UPLOAD_FIELD)(request, context_.getResponse(), done)).catch(reject);
    }).catch(async (error) => {
      // remove a partially staged archive on upload failure
      const path = request.file?.path;
      if (path) {
        await this.storageRepository.unlink(path);
      }
      throw error;
    });

    return next.handle();
  }
}
