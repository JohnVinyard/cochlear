"""
botkit: what every long-running bot here shares (see bots/README.md).

A bot follows a feed, handles each item, and keeps its place in its user's
state document (GET/PUT /v1/users/me/state), written with If-Match:

    {"<version_key>": "3", "<cursor_key>": 878, "processed": 503, "failed": 2,
     "recent_failures": [{"item": "sound 12", "error": "...", "at": "..."}]}

Subclasses provide `items(cursor)` (the feed, after the cursor, as `Item`s)
and `handle(item)`. botkit does the rest:

  - `Permanent` from handle(): the item is recorded in recent_failures and
    skipped;
  - `ConnectionError` (or a requests error): retried with backoff, without
    moving on;
  - `Fatal` (or a 401): the bot stops;
  - a state write that loses a race (412: another instance, or clear-data)
    re-reads the state and carries on from its cursor;
  - a state whose version isn't the bot's starts the feed over.

`api_error(e)` turns an ApiError raised while handling an item into one of
those.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

import requests
from cochlea_client import ApiError, CochleaClient, State, StateConflict

RECENT_FAILURES = 20


class Permanent(Exception):
    """This item can't be processed: record it and move on"""


class Fatal(Exception):
    """The bot can't continue (e.g. its API key is invalid)"""


@dataclass
class Item:
    #: saved as the bot's cursor once the item is handled
    cursor: int
    #: for logs and recent_failures, e.g. "sound 12"
    label: str
    payload: Any


def api_error(e: ApiError, what: str = "the item") -> Exception:
    """How to treat an ApiError raised while handling an item"""
    if e.status == 401:
        return Fatal(str(e))
    if e.status == 429 or e.status >= 500:
        return ConnectionError(str(e))
    if e.status in (404, 410):
        return Permanent(f"{what} was deleted ({e.status})")
    return Permanent(f"the API refused: {e}")


class FeedBot:
    #: the bot's user name; also names its key file, .data/bots/<name>.key
    name = "bot"
    #: bump when the bot's output changes: a different version starts the feed over
    version = "1"
    version_key = "version"
    cursor_key = "cursor"

    def __init__(self, client: CochleaClient, *, poll_seconds: float = 30, backoff_seconds: float = 5,
                 max_backoff_seconds: float = 300, sleep: Callable[[float], None] = time.sleep):
        self.client = client
        self.poll_seconds = poll_seconds
        self.backoff_seconds = backoff_seconds
        self.max_backoff_seconds = max_backoff_seconds
        self.sleep = sleep
        self.state: State = State({}, "")
        self.log = logging.getLogger(self.name)

    # -- to override ----------------------------------------------------------

    def setup(self) -> None:
        """Runs once before the first item, e.g. to create schemas"""

    def items(self, cursor: Optional[int]) -> Iterator[Item]:
        raise NotImplementedError

    def handle(self, item: Item) -> str:
        """Processes an item; returns a summary for the log"""
        raise NotImplementedError

    # -- state ----------------------------------------------------------------

    @property
    def bad_key(self) -> str:
        return (f"the API key was rejected (401). If the database was recreated, delete the key file "
                f"(.data/bots/{self.name}.key) and restart, to issue a new one.")

    def load_state(self) -> None:
        self.state = self.client.get_state()
        doc = self.state.document
        if doc.get(self.version_key) != self.version:
            if doc:
                self.log.info("state is for version %r, not %r: starting the feed over",
                              doc.get(self.version_key), self.version)
            self.state.document = {self.version_key: self.version, self.cursor_key: None, "processed": 0,
                                   "failed": 0, "recent_failures": []}

    @property
    def cursor(self) -> Optional[int]:
        return self.state.document.get(self.cursor_key)

    def save_state(self, update: Callable[[dict], None]) -> bool:
        """Applies `update` to the state and writes it. False if someone else wrote it first."""
        doc = dict(self.state.document)
        update(doc)
        try:
            self.state = self.client.put_state(doc, if_match=self.state.etag or None)
            return True
        except StateConflict:
            self.log.warning("state was changed elsewhere (another instance, or clear-data); re-reading it")
            self.load_state()
            return False

    # -- the loop -------------------------------------------------------------

    def failure(self, item: Item, error: Exception) -> dict:
        """What recent_failures records about an item; override to add detail"""
        return {"item": item.label, "error": str(error), "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}

    def process(self, item: Item) -> None:
        """Handles an item, retrying transient errors, and records the outcome"""
        backoff = self.backoff_seconds
        while True:
            try:
                started = time.monotonic()
                summary = self.handle(item)
                self.log.info("%s: %s (%.1fs)", item.label, summary, time.monotonic() - started)
                failure = None
                break
            except Permanent as e:
                self.log.warning("%s: skipped: %s", item.label, e)
                failure = self.failure(item, e)
                break
            except ApiError as e:
                error = api_error(e)
                if isinstance(error, Fatal):
                    raise Fatal(self.bad_key) from e
                if isinstance(error, Permanent):
                    self.log.warning("%s: skipped: %s", item.label, error)
                    failure = self.failure(item, error)
                    break
                self.log.warning("%s: %s; retrying in %.0fs", item.label, e, backoff)
            except (ConnectionError, requests.exceptions.RequestException) as e:
                self.log.warning("%s: %s; retrying in %.0fs", item.label, e, backoff)
            self.sleep(backoff)
            backoff = min(backoff * 2, self.max_backoff_seconds)

        def update(doc: dict) -> None:
            doc[self.cursor_key] = item.cursor
            if failure:
                doc["failed"] = doc.get("failed", 0) + 1
                doc["recent_failures"] = (doc.get("recent_failures", []) + [failure])[-RECENT_FAILURES:]
            else:
                doc["processed"] = doc.get("processed", 0) + 1

        self.save_state(update)

    def drain(self, limit: Optional[int] = None) -> int:
        """Processes every item after the cursor; returns how many it processed"""
        done = 0
        while True:
            restarted = False
            for item in self.items(self.cursor):
                if limit is not None and done >= limit:
                    return done
                self.process(item)
                done += 1
                if self.cursor != item.cursor:
                    restarted = True  # the state changed under us: follow its cursor instead
                    break
            if not restarted:
                return done

    def run(self, once: bool = False, limit: Optional[int] = None) -> None:
        backoff = self.backoff_seconds
        started = False
        while True:
            try:
                if not started:
                    self.setup()
                    self.load_state()
                    self.log.info("starting after %s", self.cursor)
                    started = True
                done = self.drain(limit)
                if once or limit is not None:
                    self.log.info("processed %d items; stopping", done)
                    return
                backoff = self.backoff_seconds
                self.sleep(self.poll_seconds)
                self.load_state()  # picks up a clear-data while idle
            except ApiError as e:
                if e.status == 401:
                    raise Fatal(self.bad_key) from e
                if not (e.status == 429 or e.status >= 500):
                    raise
                self.log.warning("API error: %s; retrying in %.0fs", e, backoff)
            except (ConnectionError, requests.exceptions.RequestException) as e:
                self.log.warning("can't reach the API: %s; retrying in %.0fs", e, backoff)
            self.sleep(backoff)
            backoff = min(backoff * 2, self.max_backoff_seconds)
            if started:
                self.load_state()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def add_common_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--api-url", default=os.environ.get("COCHLEA_API_URL", "http://localhost:8080/v1"))
    p.add_argument("--api-key", default=os.environ.get("COCHLEA_API_KEY"),
                   help="or COCHLEA_API_KEY, or a file in COCHLEA_API_KEY_FILE")
    p.add_argument("--once", action="store_true", help="process what's in the feed, then exit")
    p.add_argument("--limit", type=int, help="process at most N items, then exit")
    p.add_argument("--poll-seconds", type=float, default=float(os.environ.get("BOT_POLL_SECONDS", 30)))


def client_from_args(p: argparse.ArgumentParser, args: argparse.Namespace) -> CochleaClient:
    """The API client. COCHLEA_URL_REWRITES ('FROM=TO;...') rewrites blob URLs,
    e.g. http://localhost:4443/=http://gcs:4443/ inside docker compose."""
    if not args.api_key and os.environ.get("COCHLEA_API_KEY_FILE"):
        args.api_key = Path(os.environ["COCHLEA_API_KEY_FILE"]).read_text().strip()
    if not args.api_key:
        p.error("an API key is required: --api-key, COCHLEA_API_KEY or COCHLEA_API_KEY_FILE")
    rewrites = dict(r.split("=", 1) for r in os.environ.get("COCHLEA_URL_REWRITES", "").split(";") if "=" in r)
    return CochleaClient(args.api_url, args.api_key, url_rewrites=rewrites)


def run_main(bot: FeedBot, args: argparse.Namespace) -> int:
    try:
        bot.run(once=args.once, limit=args.limit)
    except Fatal as e:
        bot.log.error("%s", e)
        return 2
    except KeyboardInterrupt:
        return 130
    return 0


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s",
                        stream=sys.stdout)
