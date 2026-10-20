import { DatabaseConnectionParams } from '@immich/sql-tools';
import { RegisterQueueOptions } from '@nestjs/bullmq';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { QueueOptions } from 'bullmq';
import { Request, Response } from 'express';
import { HelmetOptions } from 'helmet';
import { RedisOptions } from 'ioredis';
import { CLS_ID, ClsModuleOptions } from 'nestjs-cls';
import { OpenTelemetryModuleOptions } from 'nestjs-otel/lib/interfaces/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VectorExtension } from 'src/types.js';
import { IWorker, citiesFile } from 'src/constants.js';
import { Telemetry } from 'src/decorators.js';
import { EnvSchema } from 'src/dtos/env.dto.js';
import {
  DatabaseExtension,
  ImmichEnvironment,
  ImmichHeader,
  ImmichTelemetry,
  ImmichWorker,
  LogFormat,
  LogLevel,
  QueueName,
} from 'src/enum.js';

export interface EnvData {
  host?: string;
  port: number;
  environment: ImmichEnvironment;
  configFile?: string;
  logLevel?: LogLevel;
  logFormat?: LogFormat;

  buildMetadata: {
    build?: string;
    buildUrl?: string;
    buildImage?: string;
    buildImageUrl?: string;
    repository?: string;
    repositoryUrl?: string;
    sourceRef?: string;
    sourceCommit?: string;
    sourceUrl?: string;
    thirdPartySourceUrl?: string;
    thirdPartyBugFeatureUrl?: string;
    thirdPartyDocumentationUrl?: string;
    thirdPartySupportUrl?: string;
  };

  bull: {
    config: QueueOptions;
    queues: RegisterQueueOptions[];
  };

  cls: {
    config: ClsModuleOptions;
  };

  helmet: {
    config?: HelmetOptions;
  };

  database: {
    config: DatabaseConnectionParams;
    skipMigrations: boolean;
    vectorExtension?: VectorExtension;
  };

  versionCheck: {
    url?: string;
  };

  network: {
    trustedProxies: string[];
  };

  otel: OpenTelemetryModuleOptions;

  resourcePaths: {
    lockFile: string;
    geodata: {
      dateFile: string;
      admin1: string;
      admin2: string;
      cities500: string;
      countryInfo: string;
      naturalEarthCountriesPath: string;
    };
    web: {
      root: string;
      indexHtml: string;
    };
    corePlugin: string;
  };

  redis: RedisOptions;

  setup: {
    allow: boolean;
  };

  telemetry: {
    apiPort: number;
    microservicesPort: number;
    metrics: Set<ImmichTelemetry>;
  };

  storage: {
    ignoreMountCheckErrors: boolean;
    mediaLocation?: string;
  };

  workers: ImmichWorker[];

  plugins: {
    external: {
      allow: boolean;
      installFolder?: string;
    };
  };

  noColor: boolean;
  nodeVersion?: string;
}

const WORKER_TYPES = new Set(Object.values(ImmichWorker));
const TELEMETRY_TYPES = new Set(Object.values(ImmichTelemetry));

const asSet = <T>(value: string | undefined, defaults: T[]) => {
  const values = (value || '').replaceAll(/\s/g, '').split(',').filter(Boolean);
  return new Set(values.length === 0 ? defaults : (values as T[]));
};

const resolveHelmetFile = (helmetFile: 'true' | 'false' | string | undefined) => {
  // default is off
  if (!helmetFile || helmetFile === 'false') {
    return;
  }

  helmetFile = helmetFile === 'true' ? join(import.meta.dirname, '..', '..', 'helmet.json') : helmetFile;

  try {
    return JSON.parse(readFileSync(helmetFile).toString()) as HelmetOptions;
  } catch (error) {
    throw new Error(`Failed to read helmet file: ${helmetFile}`, { cause: error });
  }
};

const getEnv = (): EnvData => {
  const parseResult = EnvSchema.safeParse(process.env);
  if (!parseResult.success) {
    const messages = ['Invalid environment variables: '];
    for (const issue of parseResult.error.issues) {
      const path = issue.path.join('.');
      messages.push(`  - [${path}] ${issue.message}`);
    }
    throw new Error(messages.join('\n'));
  }
  const dto = parseResult.data;

  const includedWorkers = asSet(dto.IMMICH_WORKERS_INCLUDE, [ImmichWorker.Api, ImmichWorker.Microservices]);
  const excludedWorkers = asSet(dto.IMMICH_WORKERS_EXCLUDE, []);
  const workers = [...includedWorkers.difference(excludedWorkers)];
  for (const worker of workers) {
    if (!WORKER_TYPES.has(worker)) {
      throw new Error(`Invalid worker(s) found: ${workers.join(',')}`);
    }
  }

  const environment = dto.IMMICH_ENV || ImmichEnvironment.Production;
  const buildFolder = dto.IMMICH_BUILD_DATA || '/build';
  const folders = {
    geodata: join(buildFolder, 'geodata'),
    web: join(buildFolder, 'www'),
  };

  let redisConfig = {
    host: dto.REDIS_HOSTNAME || 'redis',
    port: dto.REDIS_PORT || 6379,
    db: dto.REDIS_DBINDEX || 0,
    username: dto.REDIS_USERNAME || undefined,
    password: dto.REDIS_PASSWORD || undefined,
    path: dto.REDIS_SOCKET || undefined,
  };

  const redisUrl = dto.REDIS_URL;
  if (redisUrl && redisUrl.startsWith('ioredis://')) {
    try {
      redisConfig = JSON.parse(Buffer.from(redisUrl.slice(10), 'base64').toString());
    } catch (error) {
      throw new Error('Failed to decode redis options', { cause: error });
    }
  }

  const includedTelemetries =
    dto.IMMICH_TELEMETRY_INCLUDE === 'all'
      ? new Set(Object.values(ImmichTelemetry))
      : asSet<ImmichTelemetry>(dto.IMMICH_TELEMETRY_INCLUDE, []);

  const excludedTelemetries = asSet<ImmichTelemetry>(dto.IMMICH_TELEMETRY_EXCLUDE, []);
  const telemetries = includedTelemetries.difference(excludedTelemetries);
  for (const telemetry of telemetries) {
    if (!TELEMETRY_TYPES.has(telemetry)) {
      throw new Error(`Invalid telemetry found: ${telemetry}`);
    }
  }

  const databaseConnection: DatabaseConnectionParams = dto.DB_URL
    ? { connectionType: 'url', url: dto.DB_URL }
    : {
        connectionType: 'parts',
        host: dto.DB_HOSTNAME || 'database',
        port: dto.DB_PORT || 5432,
        username: dto.DB_USERNAME || 'postgres',
        password: dto.DB_PASSWORD || 'postgres',
        database: dto.DB_DATABASE_NAME || 'immich',
        ssl: dto.DB_SSL_MODE || undefined,
      };

  let vectorExtension: VectorExtension | undefined;
  if (dto.DB_VECTOR_EXTENSION) {
    switch (dto.DB_VECTOR_EXTENSION) {
      case 'pgvector': {
        vectorExtension = DatabaseExtension.Vector;
        break;
      }
      case 'vectorchord': {
        vectorExtension = DatabaseExtension.VectorChord;
        break;
      }
    }
  }

  return {
    host: dto.IMMICH_HOST,
    port: dto.IMMICH_PORT || 2283,
    environment,
    configFile: dto.IMMICH_CONFIG_FILE,
    logLevel: dto.IMMICH_LOG_LEVEL,
    logFormat: dto.IMMICH_LOG_FORMAT || LogFormat.Console,

    buildMetadata: {
      build: dto.IMMICH_BUILD,
      buildUrl: dto.IMMICH_BUILD_URL,
      buildImage: dto.IMMICH_BUILD_IMAGE,
      buildImageUrl: dto.IMMICH_BUILD_IMAGE_URL,
      repository: dto.IMMICH_REPOSITORY,
      repositoryUrl: dto.IMMICH_REPOSITORY_URL,
      sourceRef: dto.IMMICH_SOURCE_REF,
      sourceCommit: dto.IMMICH_SOURCE_COMMIT,
      sourceUrl: dto.IMMICH_SOURCE_URL,
      thirdPartySourceUrl: dto.IMMICH_THIRD_PARTY_SOURCE_URL || 'https://github.com/alzimerahmed/HomeRoll',
      thirdPartyBugFeatureUrl:
        dto.IMMICH_THIRD_PARTY_BUG_FEATURE_URL || 'https://github.com/alzimerahmed/HomeRoll/issues',
      thirdPartyDocumentationUrl:
        dto.IMMICH_THIRD_PARTY_DOCUMENTATION_URL || 'https://github.com/alzimerahmed/HomeRoll/wiki',
      thirdPartySupportUrl: dto.IMMICH_THIRD_PARTY_SUPPORT_URL || 'https://github.com/alzimerahmed/HomeRoll/issues',
    },

    bull: {
      config: {
        prefix: 'immich_bull',
        connection: { ...redisConfig },
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: false,
        },
      },
      queues: Object.values(QueueName).map((name) => ({ name })),
    },

    cls: {
      config: {
        middleware: {
          mount: true,
          generateId: true,
          setup: (cls, req: Request, res: Response) => {
            const cid = req.header(ImmichHeader.CorrelationId) || cls.get(CLS_ID);
            cls.set(CLS_ID, cid);
            res.header(ImmichHeader.CorrelationId, cid);
          },
        },
      },
    },

    database: {
      config: databaseConnection,
      skipMigrations: dto.DB_SKIP_MIGRATIONS ?? false,
      vectorExtension,
    },

    helmet: {
      config: resolveHelmetFile(dto.IMMICH_HELMET_FILE),
    },

    versionCheck: {
      url: dto.IMMICH_VERSION_CHECK_URL,
    },

    network: {
      trustedProxies: dto.IMMICH_TRUSTED_PROXIES ?? ['linklocal', 'uniquelocal'],
    },

    otel: {
      metrics: {
        hostMetrics: telemetries.has(ImmichTelemetry.Host),
      },
    },

    redis: redisConfig,

    resourcePaths: {
      lockFile: join(buildFolder, 'build-lock.json'),
      geodata: {
        dateFile: join(folders.geodata, 'geodata-date.txt'),
        admin1: join(folders.geodata, 'admin1CodesASCII.txt'),
        admin2: join(folders.geodata, 'admin2Codes.txt'),
        cities500: join(folders.geodata, citiesFile),
        countryInfo: join(folders.geodata, 'countryInfo.txt'),
        naturalEarthCountriesPath: join(folders.geodata, 'ne_10m_admin_0_countries.geojson'),
      },
      web: {
        root: folders.web,
        indexHtml: join(folders.web, 'index.html'),
      },
      corePlugin: join(buildFolder, 'plugins', 'immich-plugin-core'),
    },

    setup: {
      allow: dto.IMMICH_ALLOW_SETUP ?? true,
    },

    storage: {
      ignoreMountCheckErrors: !!dto.IMMICH_IGNORE_MOUNT_CHECK_ERRORS,
      mediaLocation: dto.IMMICH_MEDIA_LOCATION,
    },

    telemetry: {
      apiPort: dto.IMMICH_API_METRICS_PORT || 8081,
      microservicesPort: dto.IMMICH_MICROSERVICES_METRICS_PORT || 8082,
      metrics: telemetries,
    },

    workers,

    plugins: {
      external: {
        allow: dto.IMMICH_ALLOW_EXTERNAL_PLUGINS ?? false,
        installFolder: dto.IMMICH_PLUGINS_INSTALL_FOLDER,
      },
    },

    noColor: !!dto.NO_COLOR,
  };
};

let cached: EnvData | undefined;

@Injectable()
@Telemetry({ enabled: false })
export class ConfigRepository {
  constructor(@Inject(IWorker) @Optional() private worker?: ImmichWorker) {}

  getEnv() {
    if (!cached) {
      cached = getEnv();
    }

    return cached;
  }

  isDev() {
    return this.getEnv().environment === ImmichEnvironment.Development;
  }

  isProduction() {
    return this.getEnv().environment === ImmichEnvironment.Production;
  }

  getWorker() {
    return this.worker;
  }
}

export const clearEnvCache = () => (cached = undefined);
