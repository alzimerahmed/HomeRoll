import {
  All,
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpStatus,
  MethodNotAllowedException,
  Next,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { WebDavService } from 'src/services/webdav.service.js';
import { ImmichFileResponse, sendFile } from 'src/utils/file.js';
import {
  DAV_ALLOWED_METHODS,
  DAV_COMPLIANCE_CLASSES,
  buildLockResponse,
  buildMultistatus,
  getDavSegments,
  parseDepthHeader,
} from 'src/utils/webdav.js';

/**
 * Read-only WebDAV endpoint (FG-09).
 *
 * Single catch-all handler: PROPFIND/GET/HEAD/LOCK/UNLOCK are WebDAV verbs
 * that don't fit the OpenAPI/Zod pipeline, so the whole controller is
 * excluded from the spec (@ApiExcludeController) and dispatches on
 * `request.method`. Mounts under the global prefix at `/api/webdav`.
 *
 * `@All()` maps to Express `router.all`, which dispatches every HTTP method
 * (including PROPFIND, LOCK, etc. — `express` uses the full `methods` list).
 * `/*davPath` is the Express 5 / path-to-regexp v8 named-wildcard syntax and
 * yields `request.params.davPath` as a decoded segment array.
 */
@ApiExcludeController()
@Controller('webdav')
export class WebDavController {
  constructor(
    private service: WebDavService,
    private logger: LoggingRepository,
  ) {}

  @All(['/', '/*davPath'])
  @Authenticated({ permission: Permission.WebdavAccess })
  async handleWebDav(
    @Auth() auth: AuthDto,
    @Req() request: Request,
    @Res() response: Response,
    @Next() next: NextFunction,
  ): Promise<void> {
    const segments = getDavSegments(request.params.davPath as unknown as string[] | undefined);

    switch (request.method) {
      case 'OPTIONS': {
        response
          .set({ DAV: DAV_COMPLIANCE_CLASSES, Allow: DAV_ALLOWED_METHODS, 'MS-Author-Via': 'DAV' })
          .status(HttpStatus.OK)
          .end();
        return;
      }

      case 'PROPFIND': {
        const depth = parseDepthHeader(request.headers.depth);
        if (depth === 'infinity') {
          // RFC 4918 §9.1: servers that don't support Depth: infinity MUST reject with 403
          throw new ForbiddenException('Depth: infinity is not supported');
        }
        if (depth === 'invalid') {
          throw new BadRequestException('Invalid Depth header');
        }
        // A missing Depth header means "infinity" per RFC, but clients that omit it
        // are satisfied by a Depth: 1 response — cap rather than reject.
        const resources = await this.service.propfind(auth, segments, depth ?? 1);
        response
          .status(HttpStatus.MULTI_STATUS)
          .set({ 'Content-Type': 'application/xml; charset=utf-8', DAV: DAV_COMPLIANCE_CLASSES })
          .send(buildMultistatus(this.getBaseHref(request), resources));
        return;
      }

      case 'GET':
      case 'HEAD': {
        let file: ImmichFileResponse;
        try {
          file = await this.service.getFile(auth, segments);
        } catch (error) {
          if (error instanceof MethodNotAllowedException) {
            this.methodNotAllowed(response);
            return;
          }
          throw error;
        }
        // Express res.sendFile honors Range (206) and HEAD semantics
        await sendFile(response, next, () => file, this.logger);
        return;
      }

      case 'LOCK': {
        // Read-only tree: clients that require a lock before proceeding get an
        // inert exclusive lock token (no state is stored).
        const token = `opaquelocktoken:${randomUUID()}`;
        response
          .status(HttpStatus.OK)
          .set({ 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${token}>` })
          .send(buildLockResponse(request.path, token));
        return;
      }

      case 'UNLOCK': {
        response.status(HttpStatus.NO_CONTENT).end();
        return;
      }

      default: {
        this.methodNotAllowed(response);
      }
    }
  }

  private methodNotAllowed(response: Response) {
    response.set('Allow', DAV_ALLOWED_METHODS).status(HttpStatus.METHOD_NOT_ALLOWED).end();
  }

  /**
   * Absolute path of the DAV mount (e.g. `/api/webdav`), derived from the
   * matched route so hrefs stay correct whether or not the global `/api`
   * prefix is applied.
   */
  private getBaseHref(request: Request): string {
    // `request.route.path` is an array for @All(['/', '/*davPath']) — the Express mount
    // path in `request.baseUrl` is the reliable mount prefix (`/api/webdav`)
    return request.baseUrl || '/api/webdav';
  }
}
