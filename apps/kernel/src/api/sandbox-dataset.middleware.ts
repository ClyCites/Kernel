import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { ClientRepository } from '../identity/client.repository.js';
import { forceSeedDataset } from './dataset.js';
import { verifiedClient } from './subject.js';

@Injectable()
export class SandboxDatasetMiddleware implements NestMiddleware {
  constructor(
    @Inject(ClientRepository) private readonly clients: ClientRepository,
  ) {}

  async use(
    request: Request,
    _response: Response,
    next: NextFunction,
  ): Promise<void> {
    const clientId = verifiedClient(request);
    if (clientId !== null) {
      const client = await this.clients.current(clientId);
      if (client?.dataset === 'seed') forceSeedDataset(request);
    }
    next();
  }
}