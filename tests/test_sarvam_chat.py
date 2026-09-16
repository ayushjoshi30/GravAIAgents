"""Chat client: JSON extraction and the repair loop."""

from __future__ import annotations

import pytest
from gravai_core.errors import SchemaViolation
from gravai_sarvam import ChatMessage, ChatRequest, FakeSarvamChat, extract_json_object
from pydantic import BaseModel


class Answer(BaseModel):
    name: str
    amount: float


def _request(content: str = "extract the fields") -> ChatRequest:
    return ChatRequest(messages=(ChatMessage(role="user", content=content),), json_mode=True)


def test_extracts_bare_json() -> None:
    assert extract_json_object('{"a": 1}') == '{"a": 1}'


def test_extracts_json_from_a_code_fence() -> None:
    assert extract_json_object('```json\n{"a": 1}\n```') == '{"a": 1}'


def test_extracts_json_surrounded_by_prose() -> None:
    """Models add a preamble often enough that failing on it wastes good answers."""
    assert extract_json_object('Sure! Here you go:\n{"a": 1}\nHope that helps.') == '{"a": 1}'


def test_ignores_braces_inside_strings() -> None:
    text = '{"note": "a } brace in a string", "a": 1}'
    assert extract_json_object(text) == text


def test_empty_response_is_a_violation() -> None:
    with pytest.raises(SchemaViolation, match="empty"):
        extract_json_object("")


def test_response_without_json_is_a_violation() -> None:
    with pytest.raises(SchemaViolation, match="no JSON object"):
        extract_json_object("I am afraid I cannot do that.")


def test_unterminated_json_is_a_violation() -> None:
    with pytest.raises(SchemaViolation, match="unterminated"):
        extract_json_object('{"a": 1')


async def test_valid_first_response_needs_no_repair() -> None:
    chat = FakeSarvamChat(default='{"name": "Lakshmi", "amount": 85000}')
    answer, responses = await chat.complete_json(_request(), Answer)
    assert answer.name == "Lakshmi"
    assert len(responses) == 1


async def test_malformed_response_is_repaired() -> None:
    """The loop hands the model its own validation error and it recovers."""
    chat = FakeSarvamChat(default='{"name": "Lakshmi", "amount": 85000}', malformed_first=True)
    answer, responses = await chat.complete_json(_request(), Answer)
    assert answer.amount == 85000
    assert len(responses) == 2, "should have taken exactly one repair"


async def test_repairs_are_returned_so_they_can_be_billed() -> None:
    """A prompt needing three attempts costs three calls; the ledger must see all."""
    chat = FakeSarvamChat(default='{"name": "Lakshmi", "amount": 85000}', malformed_first=True)
    _, responses = await chat.complete_json(_request(), Answer)
    assert sum(r.usage.input_tokens for r in responses) > responses[0].usage.input_tokens


async def test_gives_up_after_max_repairs_rather_than_looping() -> None:
    """Escalate to a human instead of burning quota on the same mistake."""
    chat = FakeSarvamChat(default="never valid json at all")
    with pytest.raises(SchemaViolation, match="after 3 attempts"):
        await chat.complete_json(_request(), Answer, max_repairs=2)


async def test_repair_budget_is_respected() -> None:
    chat = FakeSarvamChat(default="still not json")
    with pytest.raises(SchemaViolation, match="after 1 attempts"):
        await chat.complete_json(_request(), Answer, max_repairs=0)
