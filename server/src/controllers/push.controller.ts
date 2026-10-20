import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  PushSubscriptionCreateDto,
  PushSubscriptionDeleteDto,
  PushSubscriptionResponseDto,
  PushTestResponseDto,
  VapidPublicKeyResponseDto,
} from 'src/dtos/push.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { PushService } from 'src/services/push.service.js';

@ApiTags(ApiTag.Push)
@Controller('push')
export class PushController {
  constructor(private service: PushService) {}

  @Get('vapid-public-key')
  @Authenticated()
  @Endpoint({
    summary: 'Retrieve the VAPID public key',
    description:
      'Retrieve the server VAPID public key used to subscribe to web push notifications. `publicKey` is null when push is not configured.',
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  getVapidPublicKey(): Promise<VapidPublicKeyResponseDto> {
    return this.service.getVapidPublicKey();
  }

  @Get('subscriptions')
  @Authenticated()
  @Endpoint({
    summary: 'Retrieve push subscriptions',
    description: 'Retrieve the push subscriptions of the current user.',
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  getPushSubscriptions(@Auth() auth: AuthDto): Promise<PushSubscriptionResponseDto[]> {
    return this.service.getSubscriptions(auth);
  }

  @Post('subscriptions')
  @Authenticated()
  @Endpoint({
    summary: 'Register a push subscription',
    description:
      'Register a web push subscription for the current user. Subscriptions are upserted by endpoint, so re-registering refreshes the existing record.',
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  createPushSubscription(
    @Auth() auth: AuthDto,
    @Body() dto: PushSubscriptionCreateDto,
    @Req() req: Request,
  ): Promise<PushSubscriptionResponseDto> {
    return this.service.subscribe(auth, dto, req.headers['user-agent']);
  }

  @Delete('subscriptions')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a push subscription',
    description: 'Delete the push subscription matching the given endpoint for the current user.',
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  deletePushSubscription(@Auth() auth: AuthDto, @Body() dto: PushSubscriptionDeleteDto): Promise<void> {
    return this.service.unsubscribe(auth, dto);
  }

  @Post('test')
  @Authenticated()
  @Endpoint({
    summary: 'Send a test push notification',
    description: "Send a test web push notification to the current user's subscriptions.",
    history: new HistoryBuilder().added('v4.0.0').alpha('v4.0.0'),
  })
  sendTestPushNotification(@Auth() auth: AuthDto): Promise<PushTestResponseDto> {
    return this.service.sendTestNotification(auth);
  }
}
