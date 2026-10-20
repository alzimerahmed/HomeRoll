import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  BrowseLabelAssetsDto,
  BrowseLabelAssetsResponseDto,
  BrowseLabelParamDto,
  BrowseLabelResponseDto,
} from 'src/dtos/browse.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { BrowseService } from 'src/services/browse.service.js';

@ApiTags(ApiTag.Browse)
@Controller('browse')
export class BrowseController {
  constructor(private service: BrowseService) {}

  @Get('labels')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get browse labels',
    description: 'List the curated CLIP-label taxonomy with per-user match counts and a preview asset for each label.',
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  getBrowseLabels(@Auth() auth: AuthDto): Promise<BrowseLabelResponseDto[]> {
    return this.service.getLabels(auth);
  }

  @Get('labels/:key')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get browse label assets',
    description: 'List the assets matching a browse label, ordered by CLIP similarity to the label prompt.',
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  getBrowseLabelAssets(
    @Auth() auth: AuthDto,
    @Param() { key }: BrowseLabelParamDto,
    @Query() dto: BrowseLabelAssetsDto,
  ): Promise<BrowseLabelAssetsResponseDto> {
    return this.service.getLabelAssets(auth, key, dto);
  }
}
