"""The remote document source, against a real HTTP server.

The parser is exercised directly, but the fetch is exercised over a real socket
on purpose: the guard, the redirect handling and the size cap all live in the
transport, and a mocked client would prove none of them.

Every server here binds to loopback, which is exactly what the guard refuses by
default — so most tests pass `allow_private=True` and one test asserts that
without it the same fetch is refused. That asymmetry is the point.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from gravai_connectors.document_source import SourceUnusable, fetch_source, parse_source
from gravai_core.netguard import UnsafeUrl

STATEMENT = {
    "account": {"bank": "Kotak Mahindra Bank", "account_last4": "7731"},
    "transactions": [
        {"date": "2026-05-01", "description": "SALARY MAY", "credit": "90000"},
    ],
}


class _Server:
    """A throwaway HTTP server that answers whatever the test tells it to."""

    def __init__(self, handler_for) -> None:
        test = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                test.seen_headers.append(dict(self.headers))
                handler_for(self)

            def log_message(self, *args):  # keep the test output readable
                return

        self.seen_headers: list[dict] = []
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def _json_server(payload, status=200):
    def handler(request):
        body = json.dumps(payload).encode()
        request.send_response(status)
        request.send_header("Content-Type", "application/json")
        request.send_header("Content-Length", str(len(body)))
        request.end_headers()
        request.wfile.write(body)

    return _Server(handler)


@pytest.fixture
def statement_server():
    server = _json_server(STATEMENT)
    yield server
    server.close()


async def test_a_json_endpoint_is_fetched_and_parsed(statement_server) -> None:
    parsed = await fetch_source(f"{statement_server.url}/docs.json", allow_private=True)
    assert parsed.transactions
    assert parsed.account["bank_name"] == "Kotak Mahindra Bank"
    assert parsed.has_facts is True
    assert parsed.peer == "127.0.0.1"


async def test_loopback_is_refused_unless_deliberately_allowed(statement_server) -> None:
    """The whole reason the guard exists.

    This server is on 127.0.0.1, and so are the API, the MCP server and the
    console on a deployed host.
    """
    with pytest.raises(UnsafeUrl, match="loopback"):
        await fetch_source(f"{statement_server.url}/docs.json")


async def test_supplied_headers_reach_the_endpoint(statement_server) -> None:
    await fetch_source(
        f"{statement_server.url}/docs.json",
        headers={"Authorization": "Bearer tenant-key"},
        allow_private=True,
    )
    assert statement_server.seen_headers[0].get("Authorization") == "Bearer tenant-key"


async def test_a_host_header_cannot_be_smuggled_in(statement_server) -> None:
    """Overriding Host is a routing trick, not a use of the headers field."""
    await fetch_source(
        f"{statement_server.url}/docs.json",
        headers={"Host": "evil.test"},
        allow_private=True,
    )
    assert statement_server.seen_headers[0].get("Host") != "evil.test"


async def test_an_error_status_is_reported_rather_than_parsed() -> None:
    server = _json_server({"error": "nope"}, status=503)
    try:
        with pytest.raises(SourceUnusable, match="503"):
            await fetch_source(f"{server.url}/docs.json", allow_private=True)
    finally:
        server.close()


async def test_a_redirect_to_a_private_address_is_refused_at_the_hop() -> None:
    """Following redirects with the client would check only the first URL."""

    def handler(request):
        request.send_response(302)
        request.send_header("Location", "http://169.254.169.254/latest/meta-data/")
        request.end_headers()

    server = _Server(handler)
    try:
        # allow_private is on, so hop one is permitted; the metadata address is
        # link-local, which stays refused because it is not private-by-RFC1918.
        with pytest.raises(UnsafeUrl):
            await fetch_source(f"{server.url}/start", allow_private=False)
    finally:
        server.close()


async def test_a_response_larger_than_the_cap_is_refused() -> None:
    def handler(request):
        body = b"x" * 40_000
        request.send_response(200)
        request.send_header("Content-Type", "application/json")
        request.send_header("Content-Length", str(len(body)))
        request.end_headers()
        request.wfile.write(body)

    server = _Server(handler)
    try:
        with pytest.raises(SourceUnusable, match="larger than"):
            await fetch_source(f"{server.url}/big", allow_private=True, max_bytes=10_000)
    finally:
        server.close()


async def test_html_is_refused_with_a_message_that_says_what_arrived() -> None:
    def handler(request):
        body = b"<html><body>login page</body></html>"
        request.send_response(200)
        request.send_header("Content-Type", "text/html")
        request.send_header("Content-Length", str(len(body)))
        request.end_headers()
        request.wfile.write(body)

    server = _Server(handler)
    try:
        with pytest.raises(SourceUnusable, match="text/html"):
            await fetch_source(f"{server.url}/page", allow_private=True)
    finally:
        server.close()


# --- the parser, without a network -----------------------------------------


def test_a_pdf_body_becomes_one_document() -> None:
    parsed = parse_source(b"%PDF-1.7 ...", "application/pdf")
    assert len(parsed.documents) == 1
    assert parsed.documents[0].content
    assert parsed.has_content is True
    assert parsed.has_facts is False


def test_base64_documents_are_decoded() -> None:
    import base64

    payload = {
        "documents": [
            {
                "declared_type": "income.bank_statement",
                "filename": "stmt.pdf",
                "content_base64": base64.b64encode(b"%PDF-1.7 hello").decode(),
            }
        ]
    }
    parsed = parse_source(json.dumps(payload).encode(), "application/json")
    assert parsed.documents[0].content == b"%PDF-1.7 hello"
    assert parsed.documents[0].declared_type == "income.bank_statement"


def test_content_that_is_not_base64_is_refused_not_guessed() -> None:
    payload = {"documents": [{"content_base64": "this is not base64!!"}]}
    with pytest.raises(SourceUnusable, match="base64"):
        parse_source(json.dumps(payload).encode(), "application/json")


def test_every_inferred_mapping_is_reported() -> None:
    """A parser that guesses silently is worse than one that refuses."""
    payload = {
        "data": {
            "lines": [
                {"value_date": "2026-04-02", "particulars": "SALARY", "credit": "65000"},
            ]
        }
    }
    parsed = parse_source(json.dumps(payload).encode(), "application/json")
    notes = " ".join(parsed.notes)
    assert "'data'" in notes
    assert "'lines'" in notes
    assert "'value_date'" in notes
    assert "'particulars'" in notes


def test_a_transaction_missing_its_amount_is_refused() -> None:
    payload = {"transactions": [{"date": "2026-04-02", "description": "SALARY"}]}
    with pytest.raises(SourceUnusable, match="amount"):
        parse_source(json.dumps(payload).encode(), "application/json")


def test_a_negative_amount_is_read_as_a_debit() -> None:
    payload = {"transactions": [{"date": "2026-04-02", "description": "RENT", "amount": "-22000"}]}
    parsed = parse_source(json.dumps(payload).encode(), "application/json")
    line = parsed.transactions[0]
    assert line["direction"] == "debit"
    # The model wants a magnitude; direction carries the sign.
    assert line["amount"] > 0
    assert any("sign of the amount" in note for note in parsed.notes)


def test_a_response_with_nothing_usable_says_what_was_expected() -> None:
    with pytest.raises(SourceUnusable, match="documents"):
        parse_source(json.dumps({"status": "ok"}).encode(), "application/json")


def test_an_empty_body_is_refused() -> None:
    with pytest.raises(SourceUnusable, match="empty"):
        parse_source(b"", "application/json")
