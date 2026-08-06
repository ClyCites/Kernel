# Developer sandbox quickstart

The sandbox uses the same API as all seven first-party applications. There is
no private integration surface. Its only difference is structural: the OAuth
client has a `seed` dataset ceiling and can never read a live row or receive a
party authorisation.

## Register and read

1. Sign up through Authentik and verify the email address. Authentik creates the
   OAuth client and owns its credentials; the kernel never stores or issues a
   secret.
2. Accept the displayed developer terms. The gateway calls
   `POST /v1/clients/sandbox/registrations` with the verified subject, client
   id, and email-verification claim. The kernel records the terms acceptance.
3. Obtain a token from Authentik with that client, then create the generated
   client:

```ts
import createClient from 'openapi-fetch';
import type { paths } from '@clycites/api-client';

const api = createClient<paths>({
  baseUrl: 'https://kernel.hope4africa.cloud/v1',
  headers: { Authorization: `Bearer ${token}` },
});

const { data, error } = await api.GET('/records/{id}', {
  params: { path: { id: '019b76da-a9b0-745e-ac8e-4f571b7eed43' } },
});
if (error) throw error;
console.log(data);
```

The gateway derives trusted identity headers from the token. Never send those
headers directly from an internet client.

## Fixture map

The corpus is deterministic (`20260803`), one season, with twenty farmers per
cooperative and at least 200 deliveries.

| Coop | Party id | What to inspect |
|---|---|---|
| A, Bukoto Farmers Cooperative Society | `019b76da-a801-71cd-80d3-f2a79c91b69d` | Tidy records and measured bag conversion |
| B, Kiryandongo Grain Growers | `019b76da-a802-7b2d-b986-a3cd9ce86c56` | Low confirmation and mass-balance drift |
| C, Kapchorwa Highland Producers | `019b76da-a803-715f-9e55-1ea9f8966737` | Bag conversion understated by 18%; farmer `019b76da-a8dd-7f83-b865-1f71ea94ae10` reproduces `conversion_mismatch` |
| D, Nebbi Bean Growers Association | `019b76da-a804-768b-8e89-dff7045f4c64` | No valid basket conversion; farmer `019b76da-a941-7828-9878-bc313431910f` reproduces `conversion_unresolved` |

Useful records:

| Case | Record id |
|---|---|
| Superseded delivery | `019b76da-a9ae-7361-8ce0-894bf6550782` |
| Fork parent | `019b76da-a9b0-745e-ac8e-4f571b7eed43` |
| Partially fulfilled agreement | `019b76da-a9ab-7831-925c-aeef8bab0053` |
| Agreement affected by a fork | `019b76da-a9a9-78d9-846c-2eaf3e860248` |

The corpus also includes confirmed and unconfirmed deliveries, declared loss,
retraction, unresolved region scope, and settled and unsettled obligations.

## Reset policy

The sandbox resets nightly at 02:00 UTC. Treat every write as disposable.
Stable fixture ids return after each reset; ids created by developers do not.