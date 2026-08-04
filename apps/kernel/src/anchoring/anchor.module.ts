import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { RecordsModule } from '../records/records.module.js';
import { AnchorRepository } from './anchor.repository.js';
import { AnchorService } from './anchor.service.js';
import { HCS_PUBLISHER, HederaPublisher, type TopicPublisher } from './publisher.js';

// Read straight from the environment rather than through `loadConfig()`, for
// the same reason `TrainingModule` and `MediaModule` do: a factory that calls
// `loadConfig()` runs during module construction in every Nest test, including
// the ones with no anchoring configured at all.

/**
 * The sentence an operator has to type out in full before this kernel will
 * publish to mainnet. Deliberately long and deliberately not a boolean.
 */
export const MAINNET_ACKNOWLEDGEMENT =
  'I understand that mainnet anchoring is irreversible and that this data has been field validated';

function publisherFromEnvironment(): TopicPublisher | null {
  const topicId = process.env['ANCHOR_TOPIC_ID'];
  const accountId = process.env['ANCHOR_OPERATOR_ID'];
  const privateKey = process.env['ANCHOR_OPERATOR_KEY'];
  const network = process.env['ANCHOR_NETWORK'] ?? 'testnet';

  if (!topicId || !accountId || !privateKey) return null;

  if (network !== 'testnet' && network !== 'mainnet') {
    throw new Error(`ANCHOR_NETWORK must be testnet or mainnet, not ${network}`);
  }

  // Mainnet is a deliberate decision, not a config change. A root published
  // there cannot be unpublished, and until field validation is done we do not
  // know that the records under it are real.
  if (
    network === 'mainnet' &&
    process.env['ANCHOR_MAINNET_ACKNOWLEDGED'] !== MAINNET_ACKNOWLEDGEMENT
  ) {
    throw new Error(
      'ANCHOR_NETWORK=mainnet requires ANCHOR_MAINNET_ACKNOWLEDGED to be set to ' +
        `exactly: ${MAINNET_ACKNOWLEDGEMENT}`,
    );
  }

  return new HederaPublisher({ network, topicId, accountId, privateKey });
}

@Module({
  imports: [RecordsModule, AuditModule],
  providers: [
    AnchorRepository,
    AnchorService,
    { provide: HCS_PUBLISHER, useFactory: publisherFromEnvironment },
  ],
  exports: [AnchorService, AnchorRepository],
})
export class AnchoringModule {}
