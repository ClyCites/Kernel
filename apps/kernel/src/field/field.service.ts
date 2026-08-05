import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import { RecordRepository } from '../records/record.repository.js';
import { partiesOf } from '../records/subjects.js';
import { toDocument, type Dataset } from '../records/record.js';
import {
  FieldRepository,
  type ConfirmationRequestRow,
  type FieldEventRow,
} from './field.repository.js';

export type FieldEventInput =
  | { event: 'delegation_basis'; choice: 'witnessed_in_person' | 'ussd_confirmation' | 'organisational_bylaw' }
  | { event: 'name_collision'; choice: 'created_separate' | 'same_as_linked' | 'kept_separate' }
  | { event: 'season_label'; choice: 'registry_label' | 'officer_label' | 'no_label' }
  | { event: 'missing_field'; choice: 'unsupported'; flow: FieldFlow; step: string }
  | { event: 'flow_abandoned'; choice: 'abandoned'; flow: FieldFlow; step: string };

export type FieldFlow =
  | 'enrolment'
  | 'delivery'
  | 'confirmation'
  | 'calibration'
  | 'media'
  | 'sync';

@Injectable()
export class FieldService {
  constructor(
    @Inject(FieldRepository) private readonly repository: FieldRepository,
    @Inject(RecordRepository) private readonly records: RecordRepository,
  ) {}

  async requestConfirmation(input: {
    delivery: string;
    requester: string;
    clientId: string;
    dataset: Dataset;
  }): Promise<ConfirmationRequestRow> {
    const delivery = await this.records.findById(input.delivery);
    if (
      delivery === null ||
      delivery.type !== 'delivery' ||
      delivery.dataset !== input.dataset ||
      !partiesOf(toDocument(delivery)).includes(input.requester)
    ) {
      throw new NotFoundException(`no delivery ${input.delivery}`);
    }

    return this.repository.queueConfirmation({
      id: uuidv7(),
      delivery: input.delivery,
      requestedBy: input.requester,
      clientId: input.clientId,
      dataset: input.dataset,
    });
  }

  confirmationRequests(
    requester: string,
    dataset: Dataset,
  ): Promise<ConfirmationRequestRow[]> {
    return this.repository.confirmationRequests(requester, dataset);
  }

  recordEvent(input: {
    clientId: string;
    actingFor: string;
    event: FieldEventInput;
  }): Promise<FieldEventRow> {
    return this.repository.recordEvent({
      id: uuidv7(),
      client_id: input.clientId,
      acting_for: input.actingFor,
      event: input.event.event,
      choice: input.event.choice,
      flow: 'flow' in input.event ? input.event.flow : null,
      step: 'step' in input.event ? input.event.step : null,
    });
  }
}