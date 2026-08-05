"""MkDocs hooks.

The API reference is rendered from `apps/kernel/openapi.json`, which is itself
generated from the Zod schemas. Copying it in at build time rather than keeping
a second copy under `docs/` means there is no hand-maintained API page and no
committed duplicate to drift from the contract.
"""

import shutil
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE = REPO_ROOT / "apps" / "kernel" / "openapi.json"

# The swagger directive resolves its filename relative to the .md that contains
# it, on disk — so the copy has to land beside the page, not at the docs root.
DESTINATION = REPO_ROOT / "docs" / "building" / "openapi.json"


def on_pre_build(config, **kwargs):
    if not SOURCE.is_file():
        raise FileNotFoundError(
            f"{SOURCE} is missing. Run `pnpm openapi` — the API reference is "
            "generated from that document and has no hand-written fallback."
        )
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE, DESTINATION)
