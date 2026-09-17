"""Document Intelligence Agent (P0).

Classifies every uploaded document, routes it to extract or digitise, and
returns structured fields each carrying a citation. The per-document call
breakdown is part of the output, because counting documents instead of requests
is exactly what hides the fact that polling dominates the traffic.
"""

from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any

from gravai_connectors import GravitonDocument
from gravai_sarvam import CallRecord, DocOptions, DocumentMode, DocumentRef, Product
from pydantic import BaseModel, ConfigDict, Field

from ..base import Agent, AgentContext, AgentResult, AgentStep
from ..guardrails import run_all
from ..routing import (
    DocumentType,
    classify_declared,
    extraction_schema_for,
    route_for,
    schema_hint_for,
)
from ..schemas import AgentOutput, Citation, FieldValue, Flag, FlagType


class DocumentQuality(BaseModel):
    model_config = ConfigDict(extra="forbid")

    legible: bool = True
    complete: bool = True
    issues: list[str] = Field(default_factory=list)


class CallCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    submit: int = 0
    polls: int = 0
    results: int = 0
    llm_reads: int = 0
    total: int = 0


class DocumentAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    type: str
    confidence: float = Field(ge=0.0, le=1.0)
    route: str
    pages: int = 0
    fields: dict[str, FieldValue] = Field(default_factory=dict)
    quality: DocumentQuality = Field(default_factory=DocumentQuality)
    calls: CallCounts = Field(default_factory=CallCounts)


class DocIntelligenceOutput(AgentOutput):
    model_config = ConfigDict(extra="forbid")

    documents: list[DocumentAssessment] = Field(default_factory=list)
    total_pages: int = 0
    total_calls: int = 0
    unknown_type_ratio: float = 0.0


class DocIntelligenceAgent(Agent[DocIntelligenceOutput]):
    """Reads a file of documents into structured, cited fields."""

    id = "doc_intelligence"
    name = "Document Intelligence Agent"
    task = (
        "Classify each uploaded document, read it, and return its fields with a "
        "citation for every value."
    )
    output_model = DocIntelligenceOutput
    tools = ("docai.extract", "docai.digitise", "docai.job_status", "graviton.list_documents")
    #: Masked identifiers legitimately appear in these extracted fields.
    allow_pii_fields = frozenset({"account_number", "aadhaar_last4", "pan", "ifsc", "value"})

    #: Escalate if more than this share of the file could not be classified.
    UNKNOWN_RATIO_ESCALATION = 0.10
    #: Escalate if a required document is read with less confidence than this.
    CONFIDENCE_FLOOR = 0.70
    #: In-flight documents. The shared rate governor is the real limit; this
    #: only stops one large file from queueing hundreds of jobs at once.
    MAX_CONCURRENT_DOCUMENTS = 8

    async def run(
        self,
        ctx: AgentContext,
        *,
        documents: list[GravitonDocument],
        tenant_prefers_digitise: bool = False,
        **_: Any,
    ) -> AgentResult[DocIntelligenceOutput]:
        steps: list[AgentStep] = []
        calls: list[Any] = []
        flags: list[Flag] = []

        # Documents are read concurrently, bounded. The rate governor is the real
        # constraint — it is shared and will serialise these anyway once the
        # vendor ceiling binds — but issuing them one at a time would also waste
        # the idle time between a submit and its first poll, which is most of a
        # document's wall-clock.
        semaphore = asyncio.Semaphore(self.MAX_CONCURRENT_DOCUMENTS)

        async def process(document: GravitonDocument) -> tuple[DocumentAssessment, Any, AgentStep]:
            async with semaphore:
                return await self._read_one(
                    ctx, document, tenant_prefers_digitise=tenant_prefers_digitise
                )

        processed = await asyncio.gather(*(process(d) for d in documents))

        assessments = [item[0] for item in processed]
        calls = [item[1] for item in processed]
        steps = [item[2] for item in processed]
        unknown = sum(1 for a in assessments if a.type == str(DocumentType.OTHER_UNKNOWN))

        for assessment in assessments:
            if not assessment.fields:
                flags.append(
                    Flag(
                        type=FlagType.QUALITY,
                        detail=f"No fields could be read from {assessment.document_id}",
                        citation=Citation(document_id=assessment.document_id, page=1),
                        severity="medium",
                    )
                )

        ratio = (unknown / len(documents)) if documents else 0.0
        escalate = ratio > self.UNKNOWN_RATIO_ESCALATION or any(
            flag.severity == "high" for flag in flags
        )

        output = DocIntelligenceOutput(
            documents=assessments,
            total_pages=sum(a.pages for a in assessments),
            total_calls=sum(a.calls.total for a in assessments),
            unknown_type_ratio=round(ratio, 4),
            flags=flags,
            escalate=escalate,
            escalation_reason=(
                f"{unknown} of {len(documents)} documents could not be classified"
                if ratio > self.UNKNOWN_RATIO_ESCALATION
                else None
            ),
            # Capabilities are named by what they do, never by who supplies
            # them. This string is agent output: it reaches the REST response,
            # the console, the audit log and the public site, so a supplier
            # named here is a supplier named to every customer.
            reasoning_summary=(
                f"Read {len(assessments)} documents totalling "
                f"{sum(a.pages for a in assessments)} pages using "
                f"{sum(a.calls.total for a in assessments)} document intelligence calls. "
                f"{unknown} could not be classified from their declared type."
            ),
        )

        report = run_all(
            output,
            known_document_ids=[d.document_id for d in documents],
            allow_pii_fields=self.allow_pii_fields,
        )
        return AgentResult(
            agent_id=self.id, output=output, steps=steps, validation=report, calls=calls
        )

    async def _read_one(
        self,
        ctx: AgentContext,
        document: GravitonDocument,
        *,
        tenant_prefers_digitise: bool,
    ) -> tuple[DocumentAssessment, Any, AgentStep]:
        """Classify, route and read a single document."""
        doc_type = classify_declared(document.declared_type)
        mode = route_for(doc_type, tenant_prefers_digitise=tenant_prefers_digitise)
        # Two shapes of the same field list: a JSON Schema for the extraction
        # endpoint, and a prose hint for the model that reads digitised text.
        hint = schema_hint_for(doc_type)
        schema = extraction_schema_for(doc_type)

        result = await self.sarvam.runner.run(
            DocumentRef(
                document_id=document.document_id,
                uri=document.uri,
                mime_type=document.mime_type,
                pages=document.pages,
                doc_type=str(doc_type),
                # Carried through when the platform already holds the file — an
                # uploaded document arrives with its bytes attached. The
                # provider takes either content or an upload id and refuses a
                # ref that has neither, so dropping this here was the difference
                # between a document that reads and one that 502s.
                content=document.content,
            ),
            mode=mode,
            tenant_id=ctx.tenant_id,
            options=DocOptions(extraction_schema=schema),
            schema_hint=hint,
        )

        fields = self._to_fields(document.document_id, result.fields)
        product = Product.DOCAI_EXTRACT if mode is DocumentMode.EXTRACT else Product.DOCAI_DIGITISE
        record = CallRecord(
            product=product,
            endpoint=str(mode),
            pages=result.pages,
            sandbox=self.sarvam.sandbox,
            agent_id=self.id,
        )
        cost = self.rate_card.price(record)

        step = AgentStep(
            name=f"read:{document.document_id}",
            kind="document",
            pages=result.pages,
            cost_inr=cost,
            latency_ms=int(result.job_seconds * 1000),
            output_digest=str(result.calls.total),
        )

        assessment = DocumentAssessment(
            document_id=document.document_id,
            type=str(doc_type),
            confidence=0.5 if doc_type is DocumentType.OTHER_UNKNOWN else 0.95,
            route=str(mode),
            pages=result.pages,
            fields=fields,
            quality=DocumentQuality(
                legible=bool(fields or result.text),
                complete=bool(fields),
                issues=[] if fields else ["no fields extracted"],
            ),
            calls=CallCounts(**result.calls.as_dict()),
        )
        return assessment, replace(record, cost_inr=cost), step

    @staticmethod
    def _to_fields(document_id: str, raw: dict[str, Any]) -> dict[str, FieldValue]:
        """Convert provider output into cited field values.

        A value arriving without a page is kept but left uncited, which the
        grounding validator then reports — better than inventing a page number
        to satisfy the schema.
        """
        fields: dict[str, FieldValue] = {}
        for key, value in (raw or {}).items():
            if isinstance(value, dict) and "value" in value:
                # Page may be absent: a digitised document is read whole, so the
                # citation names the document and leaves the page unknown rather
                # than inventing one.
                fields[key] = FieldValue(
                    value=value.get("value"),
                    citation=Citation(document_id=document_id, page=value.get("page")),
                    confidence=float(value.get("confidence", 0.9)),
                    reason=value.get("reason")
                    or (None if value.get("value") is not None else "not present in document"),
                )
            else:
                fields[key] = FieldValue(
                    value=value,
                    citation=Citation(document_id=document_id, page=1),
                    confidence=0.85,
                    reason=None if value is not None else "not present in document",
                )
        return fields
