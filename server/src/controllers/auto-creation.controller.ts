import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AutoCreationRunDto, AutoCreationStatusDto } from 'src/dtos/auto-creation.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AutoCreationService } from 'src/services/auto-creation.service.js';

@ApiTags(ApiTag.AutoCreations)
@Controller('auto-creations')
export class AutoCreationController {
  constructor(private service: AutoCreationService) {}

  @Post('run')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Run an auto-creation',
    description:
      'Queue generation of an auto-creation (collage, animation, or trip highlights) for the current user. Results are stored as archived assets and albums.',
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  run(@Auth() auth: AuthDto, @Body() dto: AutoCreationRunDto): Promise<AutoCreationStatusDto> {
    return this.service.run(auth, dto);
  }
}
