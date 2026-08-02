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

const Subject = z.uuid();

export function verifiedSubject(request: Request): string | null {
  const claim = request.header(SUBJECT_HEADER);
  const parsed = Subject.safeParse(claim);
  return parsed.success ? parsed.data : null;
}
