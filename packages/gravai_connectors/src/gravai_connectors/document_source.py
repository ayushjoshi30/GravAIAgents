"""Reading an application's documents from a URL the tenant supplies.

This is the production adapter for the document side of the platform: instead
of the sandbox fixtures, GravAI issues a GET against an endpoint you control
and uses what comes back. It closes the gap that made every run synthetic —
your endpoint is where your real data lives.

Two shapes of response are useful, and they are useful for different reasons:

* **Documents** (`content_base64`) — the files themselves. Extracting anything
  from them needs the document-AI layer configured, because reading a PDF is
  the one thing this platform cannot do in code.
* **Facts** (`transactions`, `application`) — already-extracted data. This
  needs no document-AI key at all, because everything downstream of extraction
  is ordinary arithmetic: reconciliation, the income assessment, the scorecard,
  the instalment maths, the policy rules. Point this at your real figures and
  the numbers that come back are real answers about them.

The parser is deliberately forgiving about field names, because no two lenders
spell a statement line the same way. It is equally deliberately loud about what
it did: every mapping it inferred is reported back in `notes`. A parser that
guesses silently produces a confident answer about the wrong column, which is
worse than refusing the file.
"""

from __future__ import annotations

import base64
import binascii
import functools
import json
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from gravai_core.netguard import ApprovedTarget, UnsafeUrl, approve, peer_is_approved

#: Response bodies larger than this are refused rather than buffered.
DEFAULT_MAX_BYTES = 20 * 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 20.0
DEFAULT_MAX_REDIRECTS = 3

#: Headers never forwarded, whatever the caller passes.
_BANNED_HEADERS = frozenset({"host", "content-length", "connection", "transfer-encoding"})


class SourceUnusable(ValueError):
    """The endpoint answered, but not with anything that can be used."""


@dataclass(frozen=True, slots=True)
class SourceDocument:
    """One document as the endpoint supplied it."""

    document_id: str
    declared_type: str | None
    mime_type: str
    filename: str
    #: Decoded bytes, present only when the endpoint sent content.
    content: bytes | None
    pages: int | None = None

    @property
    def size_bytes(self) -> int:
        return len(self.content) if self.content else 0


@dataclass(frozen=True, slots=True)
class ParsedSource:
    """Everything usable that came back from one fetch."""

    documents: tuple[SourceDocument, ...] = ()
    #: Statement lines, already in the shape the analytics agent accepts.
    transactions: tuple[dict[str, Any], ...] = ()
    #: Application-level fields (loan amount, bureau score, income, ...).
    application: dict[str, Any] = field(default_factory=dict)
    #: Account context: bank, account_last4, opening_balance, closing_balance.
    account: dict[str, Any] = field(default_factory=dict)
    #: Every mapping decision the parser made, in plain words.
    notes: tuple[str, ...] = ()
    content_type: str = ""
    bytes_fetched: int = 0
    peer: str = ""

    @property
    def has_facts(self) -> bool:
        """Whether this can drive agents without the document-AI layer."""
        return bool(self.transactions or self.application or self.account)

    @property
    def has_content(self) -> bool:
        """Whether any document arrived with bytes that would need extracting."""
        return any(doc.content for doc in self.documents)


# --- fetching ---------------------------------------------------------------


def _clean_headers(headers: dict[str, str] | None) -> dict[str, str]:
    if not headers:
        return {}
    return {
        key: value
        for key, value in headers.items()
        if key.strip().lower() not in _BANNED_HEADERS
    }


def _peer_of(response: Any) -> str | None:
    stream = response.extensions.get("network_stream")
    if stream is None:
        return None
    address = stream.get_extra_info("server_addr")
    if not address:
        return None
    return str(address[0])


async def fetch_source(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    allow_private: bool = False,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_redirects: int = DEFAULT_MAX_REDIRECTS,
) -> ParsedSource:
    """GET the URL and parse what comes back.

    Redirects are followed by hand rather than by the client, because each hop
    is a fresh chance to land somewhere private and has to be approved on its
    own. Supplied headers are dropped the moment a redirect leaves the original
    origin, so an endpoint cannot bounce your API key to a host you did not
    give it to.
    """
    import anyio
    import httpx

    sent_headers = _clean_headers(headers)
    current = url
    origin: tuple[str, int] | None = None
    seen: list[str] = []

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        for hop in range(max_redirects + 1):
            # Bound explicitly rather than closed over: `current` changes on
            # every redirect, and a lambda reading it later would approve one
            # URL and fetch another.
            approve_this = functools.partial(approve, current, allow_private=allow_private)
            target: ApprovedTarget = await anyio.to_thread.run_sync(approve_this)

            if origin is None:
                origin = (target.host, target.port)
            elif (target.host, target.port) != origin:
                # A redirect that changes origin must not carry the caller's
                # credentials with it.
                sent_headers = {}

            async with client.stream(
                "GET", current, headers={"Accept": "application/json, */*", **sent_headers}
            ) as response:
                peer = _peer_of(response)
                if not peer_is_approved(target, peer):
                    where = peer or "an address that could not be determined"
                    raise UnsafeUrl(
                        f"{target.host} answered from {where}, which is not one of the "
                        "addresses it resolved to. The response was discarded unread."
                    )

                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise SourceUnusable(
                            f"The endpoint returned {response.status_code} with no location header."
                        )
                    seen.append(current)
                    current = str(httpx.URL(current).join(location))
                    if current in seen:
                        raise SourceUnusable("The endpoint redirects in a loop.")
                    continue

                if response.status_code >= 400:
                    raise SourceUnusable(
                        f"The endpoint returned {response.status_code}. "
                        "It must answer a plain GET with 200."
                    )

                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        raise SourceUnusable(
                            f"The response is larger than {max_bytes // (1024 * 1024)} MB."
                        )

                content_type = response.headers.get("content-type", "").split(";")[0].strip()
                parsed = parse_source(bytes(body), content_type)
                return ParsedSource(
                    documents=parsed.documents,
                    transactions=parsed.transactions,
                    application=parsed.application,
                    account=parsed.account,
                    notes=parsed.notes
                    + ((f"followed {hop} redirect(s)",) if hop else ()),
                    content_type=content_type,
                    bytes_fetched=len(body),
                    peer=peer or "",
                )

    raise SourceUnusable(f"The endpoint redirected more than {max_redirects} times.")


# --- parsing ----------------------------------------------------------------


def _first(mapping: dict[str, Any], *names: str) -> tuple[Any, str | None]:
    """The first present key among `names`, and which one it was."""
    for name in names:
        if name in mapping and mapping[name] not in (None, ""):
            return mapping[name], name
    return None, None


def _as_decimal(raw: Any, what: str) -> Decimal:
    try:
        return Decimal(str(raw).replace(",", "").strip())
    except (InvalidOperation, AttributeError) as exc:
        raise SourceUnusable(f"{what} is not a number: {raw!r}") from exc


def _direction_of(entry: dict[str, Any], amount: Decimal) -> tuple[str, str | None]:
    """Work out credit or debit, saying how it was worked out."""
    raw, key = _first(entry, "direction", "type", "txn_type", "dr_cr", "indicator")
    if raw is not None:
        text = str(raw).strip().lower()
        if text in {"credit", "cr", "c", "deposit", "inflow"}:
            return "credit", key
        if text in {"debit", "dr", "d", "withdrawal", "outflow"}:
            return "debit", key
        raise SourceUnusable(f"{raw!r} is not a recognisable credit/debit indicator")

    # Separate credit and debit columns are the other common shape.
    credit, credit_key = _first(entry, "credit", "deposit", "cr_amount")
    debit, debit_key = _first(entry, "debit", "withdrawal", "dr_amount")
    if credit is not None and debit is None:
        return "credit", credit_key
    if debit is not None and credit is None:
        return "debit", debit_key

    if amount < 0:
        return "debit", "sign of amount"
    return "credit", "sign of amount"


def _transaction(entry: dict[str, Any], index: int, notes: set[str]) -> dict[str, Any]:
    when, when_key = _first(
        entry, "date", "txn_date", "transaction_date", "value_date", "posted_on"
    )
    if when is None:
        raise SourceUnusable(f"Transaction {index + 1} has no date.")
    if when_key != "date":
        notes.add(f"read the transaction date from {when_key!r}")

    narration, narration_key = _first(
        entry, "narration", "description", "particulars", "details", "remarks", "text"
    )
    if narration is None:
        raise SourceUnusable(f"Transaction {index + 1} has no description.")
    if narration_key != "narration":
        notes.add(f"read the description from {narration_key!r}")

    raw_amount, _ = _first(entry, "amount", "value", "credit", "debit")
    if raw_amount is None:
        raise SourceUnusable(f"Transaction {index + 1} has no amount.")
    amount = _as_decimal(raw_amount, f"Transaction {index + 1} amount")

    direction, how = _direction_of(entry, amount)
    if how in {"sign of amount"}:
        notes.add("took credit/debit from the sign of the amount")
    elif how not in {"direction", None}:
        notes.add(f"took credit/debit from {how!r}")

    balance, balance_key = _first(entry, "balance", "running_balance", "closing_balance")
    if balance_key and balance_key != "balance":
        notes.add(f"read the running balance from {balance_key!r}")

    line: dict[str, Any] = {
        "date": str(when),
        "narration": str(narration),
        # The model wants a magnitude; direction carries the sign.
        "amount": abs(amount),
        "direction": direction,
    }
    if balance is not None:
        line["balance"] = _as_decimal(balance, f"Transaction {index + 1} balance")
    if entry.get("document_id"):
        line["document_id"] = str(entry["document_id"])
    if entry.get("page") is not None:
        line["page"] = int(entry["page"])
    return line


def _document(entry: dict[str, Any], index: int, notes: set[str]) -> SourceDocument:
    raw_content, content_key = _first(entry, "content_base64", "content", "base64", "data", "file")
    content: bytes | None = None
    if raw_content is not None:
        try:
            content = base64.b64decode(str(raw_content), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise SourceUnusable(
                f"Document {index + 1}: {content_key!r} is not valid base64."
            ) from exc
        if content_key != "content_base64":
            notes.add(f"read document bytes from {content_key!r}")

    declared, declared_key = _first(entry, "declared_type", "type", "doc_type", "category", "kind")
    if declared_key and declared_key != "declared_type":
        notes.add(f"read the document type from {declared_key!r}")

    filename, _ = _first(entry, "filename", "name", "file_name")
    mime, _ = _first(entry, "mime_type", "mime", "content_type")
    pages, _ = _first(entry, "pages", "page_count")

    identifier, _ = _first(entry, "document_id", "id", "reference")

    return SourceDocument(
        document_id=str(identifier) if identifier else f"remote-doc-{index + 1:03d}",
        declared_type=str(declared) if declared else None,
        mime_type=str(mime) if mime else "application/pdf",
        filename=str(filename) if filename else f"document-{index + 1:03d}",
        content=content,
        pages=int(pages) if pages is not None else None,
    )


def _account(raw: dict[str, Any], notes: set[str]) -> dict[str, Any]:
    """Normalise the account summary to the document reader's vocabulary.

    The runner reconciles against whatever supplied the account context, and it
    must not care whether that was a document or an endpoint. Emitting the
    endpoint's own spelling here means the runner silently finds nothing and
    reports an unnamed bank on a `0000` account, having looked for a key that
    this side never sends.
    """
    out: dict[str, Any] = {}
    for canonical, aliases in (
        ("bank_name", ("bank_name", "bank", "institution")),
        (
            "account_number",
            ("account_number", "account", "account_last4", "number"),
        ),
        ("opening_balance", ("opening_balance", "opening", "balance_opening")),
        ("closing_balance", ("closing_balance", "closing", "balance_closing")),
    ):
        value, key = _first(raw, *aliases)
        if value is None:
            continue
        out[canonical] = value
        if key != canonical:
            notes.add(f"read {canonical} from {key!r}")
    return out


def parse_source(body: bytes, content_type: str) -> ParsedSource:
    """Turn a response body into documents and facts.

    Split from the fetch so it can be tested against a response without a
    network, and so a caller can parse a body it obtained some other way.
    """
    if not body:
        raise SourceUnusable("The endpoint returned an empty body.")

    notes: set[str] = set()

    # A raw file is the simplest possible source: the whole body is one
    # document. Worth supporting because it is what a plain static PDF URL is.
    is_raw_file = (
        content_type
        and not content_type.endswith("json")
        and content_type.startswith(("application/pdf", "image/", "application/octet-stream"))
    )
    if is_raw_file:
            notes.add(f"treated the whole {content_type} body as a single document")
            return ParsedSource(
                documents=(
                    SourceDocument(
                        document_id="remote-doc-001",
                        declared_type=None,
                        mime_type=content_type,
                        filename="document-001",
                        content=bytes(body),
                    ),
                ),
                notes=tuple(sorted(notes)),
            )

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise SourceUnusable(
            f"The endpoint answered with {content_type or 'an unknown type'}, which is neither "
            f"JSON nor a document: {exc.msg}"
        ) from exc

    # A bare list is taken as the document list, which is what a simple
    # endpoint most often returns.
    if isinstance(payload, list):
        notes.add("treated the top-level array as the document list")
        payload = {"documents": payload}

    if not isinstance(payload, dict):
        raise SourceUnusable("The JSON must be an object or an array.")

    # Some APIs wrap everything one level down.
    for wrapper in ("data", "result", "payload"):
        inner = payload.get(wrapper)
        if isinstance(inner, dict) and not any(
            key in payload for key in ("documents", "transactions", "application")
        ):
            notes.add(f"unwrapped the response from {wrapper!r}")
            payload = inner
            break

    raw_documents, documents_key = _first(payload, "documents", "files", "attachments")
    raw_transactions, transactions_key = _first(payload, "transactions", "lines", "entries")
    raw_application, application_key = _first(payload, "application", "applicant", "loan")
    raw_account, account_key = _first(payload, "account", "statement", "summary")

    if documents_key and documents_key != "documents":
        notes.add(f"read the document list from {documents_key!r}")
    if transactions_key and transactions_key != "transactions":
        notes.add(f"read the transaction list from {transactions_key!r}")

    documents: list[SourceDocument] = []
    if raw_documents:
        if not isinstance(raw_documents, list):
            raise SourceUnusable("`documents` must be an array.")
        documents = [_document(entry, i, notes) for i, entry in enumerate(raw_documents)]

    transactions: list[dict[str, Any]] = []
    if raw_transactions:
        if not isinstance(raw_transactions, list):
            raise SourceUnusable("`transactions` must be an array.")
        transactions = [_transaction(entry, i, notes) for i, entry in enumerate(raw_transactions)]

    application = dict(raw_application) if isinstance(raw_application, dict) else {}
    if application_key and application_key != "application":
        notes.add(f"read the application from {application_key!r}")

    account = _account(raw_account, notes) if isinstance(raw_account, dict) else {}
    if account_key and account_key != "account":
        notes.add(f"read the account summary from {account_key!r}")

    if not documents and not transactions and not application and not account:
        raise SourceUnusable(
            "Nothing usable in the response. Expected at least one of `documents`, "
            "`transactions`, `application` or `account`."
        )

    return ParsedSource(
        documents=tuple(documents),
        transactions=tuple(transactions),
        application=application,
        account=account,
        notes=tuple(sorted(notes)),
        content_type=content_type,
        bytes_fetched=len(body),
    )
