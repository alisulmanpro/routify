"""MongoDB-compatible 24-hex IDs, so records migrated from MongoDB keep their IDs and clients see the same format."""
from __future__ import annotations

import itertools
import os
import re
import threading
import time

_counter = itertools.count(int.from_bytes(os.urandom(3), "big"))
_lock = threading.Lock()
_process_unique = os.urandom(5)

OBJECT_ID_RE = re.compile(r"^[a-fA-F\d]{24}$")


def new_id() -> str:
    """4-byte timestamp + 5 random bytes + 3-byte counter, exactly like a BSON ObjectId (so IDs sort by creation time)."""
    with _lock:
        count = next(_counter) & 0xFFFFFF
    return (int(time.time()).to_bytes(4, "big") + _process_unique + count.to_bytes(3, "big")).hex()


def is_object_id(value: object) -> bool:
    return isinstance(value, str) and bool(OBJECT_ID_RE.match(value))
