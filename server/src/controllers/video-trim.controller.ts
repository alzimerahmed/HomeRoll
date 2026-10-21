import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { VideoTrimDto, VideoTrimResponseDto } from 'src/dtos/video-trim.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { VideoTrimService } from 'src/services/video-trim.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller('videos')
export class VideoTrimController {
  constructor(private service: VideoTrimService) {}

  @Post(':id/trim')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Trim a video',
    description:
      'Queue a server-side trim of the video into a new archived asset. Returns the target asset id immediately; the asset appears in the archive once the trim job finishes.',
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  trim(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: VideoTrimDto): Promise<VideoTrimResponseDto> {
    return this.service.trim(auth, id, dto);
  }
}
