import { LoginResponseDto } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

describe('/server', () => {
  let admin: LoginResponseDto;
  let nonAdmin: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    nonAdmin = await utils.userSetup(admin.accessToken, createUserDto.user1);
  });

  describe('GET /server/about', () => {
    it('should return about information', async () => {
      const { status, body } = await request(app)
        .get('/server/about')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({
        version: expect.any(String),
        versionUrl: expect.any(String),
        repository: 'alzimerahmed/HomeRoll',
        repositoryUrl: 'https://github.com/alzimerahmed/HomeRoll',
        build: '1234567890',
        buildUrl: 'https://github.com/alzimerahmed/HomeRoll/actions/runs/1234567890',
        buildImage: 'e2e',
        buildImageUrl: 'https://github.com/alzimerahmed/HomeRoll/pkgs/container/immich-server',
        sourceRef: 'e2e',
        sourceCommit: 'e2eeeeeeeeeeeeeeeeee',
        sourceUrl: 'https://github.com/alzimerahmed/HomeRoll/commit/e2eeeeeeeeeeeeeeeeee',
        nodejs: expect.any(String),
        ffmpeg: expect.any(String),
        imagemagick: expect.any(String),
        libvips: expect.any(String),
        exiftool: expect.any(String),
        thirdPartySourceUrl: 'https://github.com/alzimerahmed/HomeRoll',
        thirdPartyBugFeatureUrl: 'https://github.com/alzimerahmed/HomeRoll/issues',
        thirdPartyDocumentationUrl: 'https://github.com/alzimerahmed/HomeRoll/wiki',
        thirdPartySupportUrl: 'https://github.com/alzimerahmed/HomeRoll/issues',
      });
    });
  });

  describe('GET /server/storage', () => {
    it('should return the disk information', async () => {
      const { status, body } = await request(app)
        .get('/server/storage')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({
        diskAvailable: expect.any(String),
        diskAvailableRaw: expect.any(Number),
        diskSize: expect.any(String),
        diskSizeRaw: expect.any(Number),
        diskUsagePercentage: expect.any(Number),
        diskUse: expect.any(String),
        diskUseRaw: expect.any(Number),
      });
    });
  });

  describe('GET /server/ping', () => {
    it('should respond with pong', async () => {
      const { status, body } = await request(app).get('/server/ping');
      expect(status).toBe(200);
      expect(body).toEqual({ res: 'pong' });
    });
  });

  describe('GET /server/version', () => {
    it('should respond with the server version', async () => {
      const { status, body } = await request(app).get('/server/version');
      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          major: expect.any(Number),
          minor: expect.any(Number),
          patch: expect.any(Number),
        }),
      );
      expect(Object.keys(body)).toEqual(expect.arrayContaining(['major', 'minor', 'patch', 'prerelease']));
    });
  });

  describe('GET /server/features', () => {
    it('should respond with the server features', async () => {
      const { status, body } = await request(app).get('/server/features');
      expect(status).toBe(200);
      expect(body).toEqual({
        smartSearch: false,
        configFile: false,
        duplicateDetection: false,
        facialRecognition: false,
        map: true,
        reverseGeocoding: true,
        importFaces: false,
        oauth: false,
        oauthAutoLaunch: false,
        ocr: false,
        passwordLogin: true,
        realtimeTranscoding: false,
        search: true,
        sidecar: true,
        trash: true,
        email: false,
      });
    });
  });

  describe('GET /server/config', () => {
    it('should respond with the server configuration', async () => {
      const { status, body } = await request(app).get('/server/config');
      expect(status).toBe(200);
      expect(body).toEqual({
        loginPageMessage: '',
        oauthButtonText: 'Login with OAuth',
        oauthAccountManagementUrl: '',
        trashDays: 30,
        userDeleteDelay: 7,
        isInitialized: true,
        externalDomain: '',
        publicUsers: true,
        isOnboarded: false,
        maintenanceMode: false,
        mapDarkStyleUrl: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
        mapLightStyleUrl: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
        minFaces: 3,
      });
    });
  });

  describe('GET /server/statistics', () => {
    it('should return the server stats', async () => {
      const { status, body } = await request(app)
        .get('/server/statistics')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({
        photos: 0,
        usage: 0,
        usagePhotos: 0,
        usageVideos: 0,
        usageByUser: [
          {
            quotaSizeInBytes: null,
            photos: 0,
            usage: 0,
            usagePhotos: 0,
            usageVideos: 0,
            userName: 'Immich Admin',
            userId: admin.userId,
            videos: 0,
          },
          {
            quotaSizeInBytes: null,
            photos: 0,
            usage: 0,
            usagePhotos: 0,
            usageVideos: 0,
            userName: 'User 1',
            userId: nonAdmin.userId,
            videos: 0,
          },
        ],
        videos: 0,
      });
    });
  });

  describe('GET /server/media-types', () => {
    it('should return accepted media types', async () => {
      const { status, body } = await request(app).get('/server/media-types');
      expect(status).toBe(200);
      expect(body).toEqual({
        sidecar: ['.xmp'],
        image: expect.any(Array),
        video: expect.any(Array),
      });
    });
  });

});
