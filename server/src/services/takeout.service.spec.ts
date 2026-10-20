import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { vitest } from 'vitest';
import type { JobOf } from 'src/types.js';
import { TakeoutImportState } from 'src/dtos/takeout.dto.js';
import { JobName, JobStatus } from 'src/enum.js';
import { TakeoutService } from 'src/services/takeout.service.js';
import { ArchiveFile } from 'src/utils/archive.js';
import * as archive from 'src/utils/archive.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newUuid } from 'test/small.factory.js';
import { newTestService, ServiceMocks } from 'test/utils.js';

vitest.mock('src/utils/archive.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('src/utils/archive.js')>();
  return { ...mod, readArchive: vitest.fn() };
});

const readArchive = vitest.mocked(archive.readArchive);

const ZIP_MAGIC = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(596)]);

const entry = (path: string, contents: string, mtime?: Date): ArchiveFile => ({
  path,
  size: Buffer.byteLength(contents),
  mtime,
  open: () => Readable.from([Buffer.from(contents)]),
});

const jobOf = (overrides: Partial<JobOf<JobName.TakeoutImport>> = {}): JobOf<JobName.TakeoutImport> => ({
  importId: newUuid(),
  ownerId: authStub.user1.user.id,
  archivePath: `/data/upload/${authStub.user1.user.id}/takeout/archive.zip`,
  archiveName: 'takeout.zip',
  ...overrides,
});

const bullJob = (data: object) => ({
  id: 'import-id',
  timestamp: 1000,
  data,
  progress: {} as Record<string, unknown>,
  failedReason: undefined as string | undefined,
  updateProgress: vitest.fn().mockResolvedValue(undefined),
  updateData: vitest.fn().mockResolvedValue(undefined),
  getState: vitest.fn().mockResolvedValue('active'),
  remove: vitest.fn().mockResolvedValue(undefined),
});

describe(TakeoutService.name, () => {
  let sut: TakeoutService;
  let mocks: ServiceMocks;

  beforeEach(async () => {
    ({ sut, mocks } = newTestService(TakeoutService));

    mocks.storage.createWriteStream.mockImplementation(
      () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
    );
    mocks.storage.stat.mockResolvedValue({ size: 12, mtime: new Date('2020-01-01') } as any);
    mocks.storage.readFile.mockResolvedValue(ZIP_MAGIC);
    mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(undefined);
    mocks.asset.create.mockImplementation(({ ownerId }) =>
      Promise.resolve(AssetFactory.create({ ownerId: ownerId as string })),
    );
    mocks.user.get.mockResolvedValue(UserFactory.create({ id: authStub.user1.user.id }));
    mocks.job.getJob.mockResolvedValue(bullJob({ ownerId: authStub.user1.user.id }) as any);
    mocks.job.searchJobs.mockResolvedValue([]);
    mocks.storage.readdir.mockResolvedValue([]);
    readArchive.mockReturnValue((async function* () {})());
  });

  describe('uploadArchive', () => {
    const file = { path: '/tmp/archive.zip', originalname: 'takeout.zip' } as Express.Multer.File;

    it('should queue an import job for a valid archive', async () => {
      const result = await sut.uploadArchive(authStub.user1, file);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.TakeoutImport,
        data: {
          importId: 'random-uuid',
          ownerId: authStub.user1.user.id,
          archivePath: file.path,
          archiveName: 'takeout.zip',
        },
      });
      expect(result).toEqual({ id: 'random-uuid', fileName: 'takeout.zip', status: TakeoutImportState.Queued });
    });

    it('should reject and remove an unsupported archive', async () => {
      mocks.storage.readFile.mockResolvedValue(Buffer.alloc(600));

      await expect(sut.uploadArchive(authStub.user1, file)).rejects.toThrow(BadRequestException);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(file.path);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should reject when no file was uploaded', async () => {
      await expect(sut.uploadArchive(authStub.user1, undefined)).rejects.toThrow(BadRequestException);
    });

    it('should reject when the user already has too many pending imports', async () => {
      mocks.job.searchJobs.mockResolvedValue(
        Array.from({ length: 5 }, () => ({ id: newUuid(), data: { ownerId: authStub.user1.user.id } })) as any,
      );

      await expect(sut.uploadArchive(authStub.user1, file)).rejects.toThrow(BadRequestException);
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalledWith(file.path);
    });

    it("should only count the uploader's own pending imports towards the cap", async () => {
      mocks.job.searchJobs.mockResolvedValue(
        Array.from({ length: 5 }, () => ({ id: newUuid(), data: { ownerId: 'another-user' } })) as any,
      );

      const result = await sut.uploadArchive(authStub.user1, file);

      expect(result.status).toBe(TakeoutImportState.Queued);
      expect(mocks.job.queue).toHaveBeenCalled();
    });
  });

  describe('handleTakeoutImport', () => {
    it('should import media files and apply sidecar metadata', async () => {
      const takenAt = new Date(1_600_000_000_000);
      const media = entry('Takeout/Google Photos/IMG_1234.jpg', 'photo-bytes', new Date('2019-01-01'));
      const sidecar = entry(
        'Takeout/Google Photos/IMG_1234.jpg.supplemental-metadata.json',
        JSON.stringify({
          photoTakenTime: { timestamp: '1600000000' },
          geoData: { latitude: 10.5, longitude: -20.25, altitude: 15 },
          title: 'My Photo.jpg',
          description: 'at the beach',
          people: [{ name: 'Alice' }],
        }),
      );
      readArchive.mockReturnValue(
        (async function* () {
          yield media;
          yield sidecar;
        })(),
      );

      const job = jobOf();
      const status = await sut.handleTakeoutImport(job);

      expect(status).toBe(JobStatus.Success);
      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: authStub.user1.user.id,
          originalFileName: 'IMG_1234.jpg',
          checksum: createHash('sha1').update('photo-bytes').digest(),
        }),
      );
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({
            dateTimeOriginal: takenAt,
            latitude: 10.5,
            longitude: -20.25,
            description: 'at the beach',
            lockedProperties: expect.arrayContaining(['dateTimeOriginal', 'latitude', 'longitude', 'description']),
          }),
          lockedPropertiesBehavior: 'append',
        }),
      );
      expect(mocks.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({ fileCreatedAt: takenAt, localDateTime: takenAt }),
      );
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AssetCreate',
        expect.objectContaining({ file: expect.anything() }),
      );
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetExtractMetadata, data: { id: expect.any(String), source: 'upload' } },
      ]);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(job.archivePath);
    });

    it('should skip duplicate media files', async () => {
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue('existing-asset-id');
      readArchive.mockReturnValue(
        (async function* () {
          yield entry('Takeout/dup.jpg', 'duplicate-content');
        })(),
      );

      const status = await sut.handleTakeoutImport(jobOf());

      expect(status).toBe(JobStatus.Success);
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should skip non-media entries and oversized sidecars', async () => {
      readArchive.mockReturnValue(
        (async function* () {
          yield entry('Takeout/archive_browser.html', '<html></html>');
          yield { ...entry('Takeout/big.json', 'x'), size: 8 * 1024 * 1024 };
        })(),
      );

      const status = await sut.handleTakeoutImport(jobOf());

      expect(status).toBe(JobStatus.Success);
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should count entry failures without aborting the import', async () => {
      readArchive.mockReturnValue(
        (async function* () {
          yield {
            path: 'Takeout/broken.jpg',
            size: 1,
            open: () => Promise.reject(new Error('cannot read entry')),
          };
          yield entry('Takeout/good.jpg', 'good-bytes');
        })(),
      );

      const status = await sut.handleTakeoutImport(jobOf());

      expect(status).toBe(JobStatus.Success);
      expect(mocks.asset.create).toHaveBeenCalledTimes(1);
    });

    it('should stop early when the job was cancelled before it started', async () => {
      const status = await sut.handleTakeoutImport(jobOf({ cancelled: true }));

      expect(status).toBe(JobStatus.Skipped);
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalledWith(expect.stringContaining('archive.zip'));
    });

    it('should stop early when the job is cancelled while running', async () => {
      mocks.job.getJob.mockResolvedValue(bullJob({ ownerId: authStub.user1.user.id, cancelled: true }) as any);

      readArchive.mockReturnValue(
        (async function* () {
          for (let index = 0; index < 100; index++) {
            yield entry(`Takeout/file-${index}.jpg`, `content-${index}`);
          }
        })(),
      );

      const status = await sut.handleTakeoutImport(jobOf());

      expect(status).toBe(JobStatus.Skipped);
      expect(mocks.asset.create.mock.calls.length).toBeLessThan(100);
    });

    it('should skip entries that would exceed the owner quota', async () => {
      mocks.user.get.mockResolvedValue(
        UserFactory.create({ id: authStub.user1.user.id, quotaSizeInBytes: 9, quotaUsageInBytes: 0 }),
      );
      readArchive.mockReturnValue(
        (async function* () {
          yield entry('Takeout/fits.jpg', '12345');
          yield entry('Takeout/too-big.jpg', '123456');
        })(),
      );

      const status = await sut.handleTakeoutImport(jobOf());

      expect(status).toBe(JobStatus.Success);
      // first entry fits (5 bytes); the second would push usage to 11 > 9
      expect(mocks.asset.create).toHaveBeenCalledTimes(1);
    });

    it('should not count duplicate entries against the quota', async () => {
      mocks.user.get.mockResolvedValue(
        UserFactory.create({ id: authStub.user1.user.id, quotaSizeInBytes: 9, quotaUsageInBytes: 0 }),
      );
      mocks.asset.getUploadAssetIdByChecksum
        .mockResolvedValueOnce(newUuid()) // first entry is a duplicate
        .mockResolvedValue(undefined); // subsequent entries are new
      readArchive.mockReturnValue(
        (async function* () {
          yield entry('Takeout/dup.jpg', '12345');
          yield entry('Takeout/new.jpg', '6789');
        })(),
      );

      const status = await sut.handleTakeoutImport(jobOf());

      expect(status).toBe(JobStatus.Success);
      // the duplicate does not consume quota, so the second entry (4 bytes) still fits
      expect(mocks.asset.create).toHaveBeenCalledTimes(1);
    });

    it('should update job progress with the result counts', async () => {
      const job = bullJob({ ownerId: authStub.user1.user.id });
      mocks.job.getJob.mockResolvedValue(job as any);
      readArchive.mockReturnValue(
        (async function* () {
          yield entry('Takeout/a.jpg', 'a');
        })(),
      );

      await sut.handleTakeoutImport(jobOf());

      expect(job.updateProgress).toHaveBeenCalledWith(
        expect.objectContaining({ imported: 1, duplicates: 0, errors: 0 }),
      );
    });
  });

  describe('getImports', () => {
    it('should only return imports owned by the caller', async () => {
      mocks.job.searchJobs.mockResolvedValue([
        { id: 'mine', data: { ownerId: authStub.user1.user.id } },
        { id: 'theirs', data: { ownerId: 'another-user' } },
      ] as any);

      const imports = await sut.getImports(authStub.user1);

      expect(mocks.job.getJob).toHaveBeenCalledWith(JobName.TakeoutImport, 'mine');
      expect(imports).toHaveLength(1);
    });
  });

  describe('getImport', () => {
    it('should return the status of an owned import', async () => {
      const job = bullJob({ ownerId: authStub.user1.user.id, archiveName: 'takeout.zip' });
      mocks.job.getJob.mockResolvedValue(job as any);

      const result = await sut.getImport(authStub.user1, 'import-id');

      expect(result).toMatchObject({
        id: 'import-id',
        fileName: 'takeout.zip',
        status: TakeoutImportState.Processing,
      });
    });

    it('should reject imports owned by another user', async () => {
      mocks.job.getJob.mockResolvedValue(bullJob({ ownerId: 'someone-else' }) as any);

      await expect(sut.getImport(authStub.user1, 'import-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('cancelImport', () => {
    it('should flag the job as cancelled', async () => {
      const job = bullJob({ ownerId: authStub.user1.user.id });
      mocks.job.getJob.mockResolvedValue(job as any);

      const result = await sut.cancelImport(authStub.user1, 'import-id');

      expect(job.updateData).toHaveBeenCalledWith({ ownerId: authStub.user1.user.id, cancelled: true });
      expect(result.status).toBe(TakeoutImportState.Cancelled);
    });

    it('should reject imports that already finished', async () => {
      const job = bullJob({ ownerId: authStub.user1.user.id });
      job.getState.mockResolvedValue('completed');
      mocks.job.getJob.mockResolvedValue(job as any);

      await expect(sut.cancelImport(authStub.user1, 'import-id')).rejects.toThrow(BadRequestException);
      expect(job.updateData).not.toHaveBeenCalled();
    });
  });
});
