"""Splitting documents to fit the provider's per-job page cap.

The Document Intelligence job accepts at most ten pages. A twelve-page bank
statement — the single most valuable document in a lending file — therefore is
not one job but two, and the capacity model has to say so: two submits, two poll
loops, two results fetches against the same 10/min bucket.

Splitting happens here rather than as a request parameter because the provider
has no page-range field. It expects the client to have done this already.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

from gravai_core.telemetry import get_logger

log = get_logger("gravai.sarvam.batching")

#: Vendor limit. Exceeding it is a 400, not a truncation.
MAX_PAGES_PER_JOB = 10


@dataclass(frozen=True, slots=True)
class Batch:
    """One submittable slice of a document."""

    index: int
    total: int
    #: 1-based, inclusive, in the original document.
    first_page: int
    last_page: int
    content: bytes
    filename: str

    @property
    def pages(self) -> int:
        return self.last_page - self.first_page + 1

    @property
    def is_whole_document(self) -> bool:
        return self.total == 1


def page_ranges(pages: int, limit: int = MAX_PAGES_PER_JOB) -> list[tuple[int, int]]:
    """Inclusive 1-based page ranges covering a document.

    Pure arithmetic, so the capacity model can count batches without touching a
    PDF library or the bytes themselves.
    """
    if pages <= 0:
        return [(1, 1)]
    size = max(1, limit)
    return [(start + 1, min(start + size, pages)) for start in range(0, pages, size)]


def count_pages(content: bytes) -> int | None:
    """Pages in a PDF, or None when it cannot be determined.

    Returns None rather than guessing: a wrong page count silently produces
    wrong batches, and an image has no page count at all.
    """
    try:
        from pypdf import PdfReader
    except ImportError:  # pragma: no cover - dependency is declared
        log.warning("pypdf_missing", hint="install pypdf to split multi-page documents")
        return None

    try:
        return len(PdfReader(io.BytesIO(content)).pages)
    except Exception:
        # Not a PDF, or an unreadable one. Treat as a single submittable unit.
        return None


def split_document(
    content: bytes,
    *,
    filename: str = "document.pdf",
    limit: int = MAX_PAGES_PER_JOB,
) -> list[Batch]:
    """Split into job-sized batches.

    A document that is not a PDF, or whose page count cannot be read, is
    returned whole and left to the provider to accept or reject — better than
    corrupting it with a guess.
    """
    pages = count_pages(content)

    if pages is None or pages <= limit:
        return [
            Batch(
                index=0,
                total=1,
                first_page=1,
                last_page=pages or 1,
                content=content,
                filename=filename,
            )
        ]

    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:  # pragma: no cover - dependency is declared
        return [
            Batch(0, 1, 1, pages, content, filename),
        ]

    reader = PdfReader(io.BytesIO(content))
    ranges = page_ranges(pages, limit)
    stem = filename.rsplit(".", 1)[0] or "document"

    batches: list[Batch] = []
    for index, (first, last) in enumerate(ranges):
        writer = PdfWriter()
        for page_number in range(first - 1, last):
            writer.add_page(reader.pages[page_number])
        buffer = io.BytesIO()
        writer.write(buffer)
        batches.append(
            Batch(
                index=index,
                total=len(ranges),
                first_page=first,
                last_page=last,
                content=buffer.getvalue(),
                filename=f"{stem}-p{first}-{last}.pdf",
            )
        )

    log.info(
        "document_split",
        filename=filename,
        pages=pages,
        batches=len(batches),
        limit=limit,
    )
    return batches
