import { Readable } from 'node:stream';
import { vitest } from 'vitest';
import { DownloadService } from 'src/services/download.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const archiveMock = () => ({
  addFile: vitest.fn(),
  addBuffer: vitest.fn(),
  finalize: vitest.fn(),
  stream: new Readable(),
});

describe(DownloadService.name + ' (sidecars)', () => {
  let sut: DownloadService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(DownloadService));
  });

  const fullMetadata = {
    id: '',
    originalFileName: 'IMG_1234.jpg',
    type: 'IMAGE',
    fileCreatedAt: new Date('2024-06-01T10:00:00.000Z'),
    takenAt: new Date('2024-06-01T09:30:15.000Z'),
    latitude: 48.8584,
    longitude: 2.2945,
    description: 'A trip to the tower',
    rating: 4,
    orientation: '1',
    make: 'Apple',
    model: 'iPhone 15 Pro',
    lensModel: 'triple camera',
    fNumber: 1.78,
    focalLength: 24,
    iso: 125,
    exposureTime: '1/120',
    city: 'Paris',
    state: null,
    country: 'France',
    timeZone: null,
    tags: ['vacation'],
    albums: ['Summer 2024'],
    people: ['Alice'],
  } as const;

  it('should add takeout-json and xmp sidecars next to each asset', async () => {
    const zip = archiveMock();
    const asset = AssetFactory.create({ originalFileName: 'IMG_1234.jpg' });

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
    mocks.asset.getForOriginals.mockResolvedValue([asset]);
    mocks.downloadRepository.getExportMetadata.mockResolvedValue(
      new Map([[asset.id, { ...fullMetadata, id: asset.id }]]),
    );
    mocks.storage.createZipStream.mockReturnValue(zip);

    await sut.downloadArchive(authStub.admin, { assetIds: [asset.id], include: ['sidecars'], sidecarFormat: 'both' });

    expect(mocks.downloadRepository.getExportMetadata).toHaveBeenCalledWith([asset.id]);
    expect(zip.addBuffer).toHaveBeenCalledTimes(2);
    expect(zip.addBuffer).toHaveBeenCalledWith(expect.any(Buffer), 'IMG_1234.jpg.supplemental-metadata.json');
    expect(zip.addBuffer).toHaveBeenCalledWith(expect.any(Buffer), 'IMG_1234.jpg.xmp');

    const [jsonBuffer] = zip.addBuffer.mock.calls[0] as [Buffer, string];
    const json = JSON.parse(jsonBuffer.toString('utf8'));
    expect(json.photoTakenTime.timestamp).toBe(
      Math.floor(new Date('2024-06-01T09:30:15.000Z').getTime() / 1000).toString(),
    );
    expect(json.description).toBe('A trip to the tower');
    expect(json.people).toEqual([{ name: 'Alice' }]);
  });

  it('should honor sidecarFormat=xmp (no JSON sidecar)', async () => {
    const zip = archiveMock();
    const asset = AssetFactory.create({ originalFileName: 'IMG_1234.jpg' });

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
    mocks.asset.getForOriginals.mockResolvedValue([asset]);
    mocks.downloadRepository.getExportMetadata.mockResolvedValue(
      new Map([[asset.id, { ...fullMetadata, id: asset.id }]]),
    );
    mocks.storage.createZipStream.mockReturnValue(zip);

    await sut.downloadArchive(authStub.admin, { assetIds: [asset.id], include: ['sidecars'], sidecarFormat: 'xmp' });

    expect(zip.addBuffer).toHaveBeenCalledTimes(1);
    expect(zip.addBuffer).toHaveBeenCalledWith(expect.any(Buffer), 'IMG_1234.jpg.xmp');
  });

  it('should not fetch or add sidecars when include is unset', async () => {
    const zip = archiveMock();
    const asset = AssetFactory.create();

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
    mocks.asset.getForOriginals.mockResolvedValue([asset]);
    mocks.storage.createZipStream.mockReturnValue(zip);

    await sut.downloadArchive(authStub.admin, { assetIds: [asset.id] });

    expect(mocks.downloadRepository.getExportMetadata).not.toHaveBeenCalled();
    expect(zip.addBuffer).not.toHaveBeenCalled();
  });

  it('should skip sidecars for shared links with showExif=false (no metadata leak)', async () => {
    const zip = archiveMock();
    const asset = AssetFactory.create();

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
    mocks.asset.getForOriginals.mockResolvedValue([asset]);
    mocks.storage.createZipStream.mockReturnValue(zip);

    await sut.downloadArchive(
      { ...authStub.adminSharedLink, sharedLink: { ...authStub.adminSharedLink.sharedLink!, showExif: false } },
      { assetIds: [asset.id], include: ['sidecars'] },
    );

    expect(mocks.downloadRepository.getExportMetadata).not.toHaveBeenCalled();
    expect(zip.addBuffer).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it('should allow sidecars for shared links with showExif=true (consistent with API EXIF exposure)', async () => {
    const zip = archiveMock();
    const asset = AssetFactory.create({ originalFileName: 'IMG_1234.jpg' });

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
    mocks.asset.getForOriginals.mockResolvedValue([asset]);
    mocks.downloadRepository.getExportMetadata.mockResolvedValue(
      new Map([[asset.id, { ...fullMetadata, id: asset.id }]]),
    );
    mocks.storage.createZipStream.mockReturnValue(zip);

    await sut.downloadArchive(authStub.adminSharedLink, { assetIds: [asset.id], include: ['sidecars'] });

    expect(mocks.downloadRepository.getExportMetadata).toHaveBeenCalledWith([asset.id]);
    expect(zip.addBuffer).toHaveBeenCalledTimes(2);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('should skip sidecars for assets without exportable metadata', async () => {
    const zip = archiveMock();
    const asset = AssetFactory.create();

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
    mocks.asset.getForOriginals.mockResolvedValue([asset]);
    mocks.downloadRepository.getExportMetadata.mockResolvedValue(new Map());
    mocks.storage.createZipStream.mockReturnValue(zip);

    await sut.downloadArchive(authStub.admin, { assetIds: [asset.id], include: ['sidecars'] });

    expect(zip.addBuffer).not.toHaveBeenCalled();
  });

  it('should name sidecars after the deduplicated asset filename', async () => {
    const zip = archiveMock();
    const asset1 = AssetFactory.create({ originalFileName: 'IMG_123.jpg' });
    const asset2 = AssetFactory.create({ originalFileName: 'IMG_123.jpg' });

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id]));
    mocks.asset.getForOriginals.mockResolvedValue([asset1, asset2]);
    mocks.downloadRepository.getExportMetadata.mockResolvedValue(
      new Map([
        [asset1.id, { ...fullMetadata, id: asset1.id }],
        [asset2.id, { ...fullMetadata, id: asset2.id }],
      ]),
    );
    mocks.storage.createZipStream.mockReturnValue(zip);

    await sut.downloadArchive(authStub.admin, { assetIds: [asset1.id, asset2.id], include: ['sidecars'] });

    const names = zip.addBuffer.mock.calls.map((call) => call[1] as string);
    expect(names).toContain('IMG_123.jpg.supplemental-metadata.json');
    expect(names).toContain('IMG_123+1.jpg.supplemental-metadata.json');
  });
});
