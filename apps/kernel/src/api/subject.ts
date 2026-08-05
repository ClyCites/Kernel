import type { Request } from 'express';
import { z } from 'zod';

/**
 * The verified subject claim. Brief §6: authentication is out of scope and
 * Authentik supplies this — the kernel receives it, it does not establish it.
 *
 * The header is trusted because the deployment boundary is trusted: nothing
 * reaches the kernel except through the gateway that sets it. Exposing this
 * port directly to the internet would make every read forgeable, so do not.
 *
 * Absent or unparseable means no requester, which the consent guard denies.
 */
export const SUBJECT_HEADER = 'x-clycites-subject';
export const CLIENT_HEADER = 'x-clycites-client-id';
export const ACTING_FOR_HEADER = 'x-acting-for';

const Subject = z.uuid();

export function verifiedSubject(request: Request): string | null {
  const claim = request.header(SUBJECT_HEADER);
  const parsed = Subject.safeParse(claim);
  return parsed.success ? parsed.data : null;
}

export function verifiedClient(request: Request): string | null {
  const claim = request.header(CLIENT_HEADER);
  return claim !== undefined &&
    claim.length > 0 &&
    claim.length <= 200 &&
    !claim.includes(',')
    ? claim
    : null;
}

export function actingFor(request: Request): string | null {
  const values = request.headers[ACTING_FOR_HEADER];
  if (Array.isArray(values) || (typeof values === 'string' && values.includes(','))) {
    return null;
  }
  const parsed = Subject.safeParse(values);
  return parsed.success ? parsed.data : null;
}
