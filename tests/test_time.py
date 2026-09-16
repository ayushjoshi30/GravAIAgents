"""Time handling and collections calling windows."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest
from gravai_core.time_utils import (
    IST,
    business_date,
    format_ddmmyyyy,
    next_call_window_open,
    parse_ddmmyyyy,
    to_ist,
    to_utc,
    within_call_window,
)


def test_utc_converts_to_ist() -> None:
    """IST is UTC+5:30."""
    moment = datetime(2026, 9, 14, 6, 0, tzinfo=UTC)
    assert to_ist(moment).hour == 11
    assert to_ist(moment).minute == 30


def test_naive_input_is_treated_as_utc_going_in() -> None:
    assert to_ist(datetime(2026, 9, 14, 6, 0)).hour == 11


def test_naive_input_is_treated_as_ist_coming_out() -> None:
    """The asymmetry is deliberate: business times are written in IST."""
    assert to_utc(datetime(2026, 9, 14, 11, 30)).hour == 6


def test_business_date_uses_the_ist_calendar() -> None:
    """23:00 UTC is already the next day in India."""
    assert business_date(datetime(2026, 9, 14, 23, 0, tzinfo=UTC)) == date(2026, 9, 15)


@pytest.mark.parametrize(
    ("hour", "allowed"),
    [(7, False), (8, True), (12, True), (19, True), (20, False), (2, False)],
)
def test_calling_window_bounds(hour: int, allowed: bool) -> None:
    """Collections calls are permitted 08:00-19:00 IST."""
    moment = datetime(2026, 9, 14, hour, 0, tzinfo=IST)
    assert within_call_window(moment) is allowed


def test_next_window_open_is_same_day_when_too_early() -> None:
    opens = to_ist(next_call_window_open(datetime(2026, 9, 14, 6, 0, tzinfo=IST)))
    assert (opens.date(), opens.hour) == (date(2026, 9, 14), 8)


def test_next_window_open_rolls_over_when_too_late() -> None:
    opens = to_ist(next_call_window_open(datetime(2026, 9, 14, 21, 0, tzinfo=IST)))
    assert (opens.date(), opens.hour) == (date(2026, 9, 15), 8)


def test_next_window_open_is_now_when_already_inside() -> None:
    moment = datetime(2026, 9, 14, 10, 0, tzinfo=IST)
    assert to_ist(next_call_window_open(moment)).hour == 10


def test_indian_date_format_round_trip() -> None:
    assert format_ddmmyyyy(date(2026, 9, 14)) == "14/09/2026"
    assert parse_ddmmyyyy("14/09/2026") == date(2026, 9, 14)
    assert parse_ddmmyyyy("14-09-2026") == date(2026, 9, 14)


def test_unparseable_date_raises() -> None:
    with pytest.raises(ValueError):
        parse_ddmmyyyy("2026-09-14")
