import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AskDto, AskResponseDto } from 'src/dtos/ask.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AskService } from 'src/services/ask.service.js';

@ApiTags(ApiTag.Ask)
@Controller('ask')
export class AskController {
  constructor(private service: AskService) {}

  @Post()
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Ask HomeRoll',
    description:
      'Ask a natural-language question about the library. Combines CLIP search, EXIF metadata filters and OCR text into an answer. Uses the configured LLM provider when available, otherwise returns a deterministic structured answer.',
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  ask(@Auth() auth: AuthDto, @Body() dto: AskDto): Promise<AskResponseDto> {
    return this.service.ask(auth, dto);
  }
}
