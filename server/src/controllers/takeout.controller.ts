import { Controller, Delete, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { TakeoutImportResponseDto, TakeoutImportStatusDto, TakeoutUploadDto } from 'src/dtos/takeout.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { TakeoutUploadInterceptor } from 'src/middleware/takeout-upload.interceptor.js';
import { TakeoutService } from 'src/services/takeout.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Takeout)
@Controller('takeout')
export class TakeoutController {
  constructor(private service: TakeoutService) {}

  @Post()
  @Authenticated({ permission: Permission.TakeoutCreate })
  @UseInterceptors(TakeoutUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'Google Takeout archive upload', type: TakeoutUploadDto })
  @Endpoint({
    summary: 'Import a Google Takeout archive',
    description:
      'Uploads a Google Takeout archive (.zip, .tar, .tar.gz) and starts a background import job. ' +
      'Media files are deduplicated by checksum and Google JSON sidecar metadata (date taken, location, ' +
      'description) is applied to the imported assets. Each uploaded archive creates a separate import job.',
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  uploadTakeoutArchive(
    @Auth() auth: AuthDto,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<TakeoutImportResponseDto> {
    return this.service.uploadArchive(auth, file);
  }

  @Get()
  @Authenticated({ permission: Permission.TakeoutRead })
  @Endpoint({
    summary: 'List takeout imports',
    description: 'Lists the takeout import jobs of the current user with their status and progress.',
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  getTakeoutImports(@Auth() auth: AuthDto): Promise<TakeoutImportStatusDto[]> {
    return this.service.getImports(auth);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.TakeoutRead })
  @Endpoint({
    summary: 'Get a takeout import',
    description: 'Returns the status and progress of a single takeout import job.',
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  getTakeoutImport(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TakeoutImportStatusDto> {
    return this.service.getImport(auth, id);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.TakeoutDelete })
  @Endpoint({
    summary: 'Cancel a takeout import',
    description:
      'Requests cancellation of a takeout import job. Queued imports are skipped, running imports stop ' +
      'at the next entry; assets already imported are kept.',
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  cancelTakeoutImport(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TakeoutImportStatusDto> {
    return this.service.cancelImport(auth, id);
  }
}
