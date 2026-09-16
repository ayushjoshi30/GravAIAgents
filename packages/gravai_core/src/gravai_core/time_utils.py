"""Time handling.

Business dates are Indian Standard Time; everything is stored in UTC. Collections
calling windows are evaluated in IST because that is what the conduct rules mean.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")

# Default collections calling window (RBI fair-practice conduct). Tenants may
# narrow it but never widen it; enforcement lives in the voice agent's policy check.
DEFAULT_CALL_WINDOW_START = time(8, 0)
DEFAULT_CALL_WINDOW_END = time(19, 0)


def utc_now() -> datetime:
    """Timezone-aware UTC now. The only clock the platform writes to storage."""
    return datetime.now(UTC)


def ist_now() -> datetime:
    """Timezone-aware IST now, for business-date decisions."""
    return datetime.now(IST)


def to_ist(moment: datetime) -> datetime:
    """Convert any aware datetime to IST. Naive input is assumed UTC."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(IST)


def to_utc(moment: datetime) -> datetime:
    """Convert any aware datetime to UTC. Naive input is assumed IST."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=IST)
    return moment.astimezone(UTC)


def business_date(moment: datetime | None = None) -> date:
    """The IST calendar date a moment belongs to."""
    return to_ist(moment or utc_now()).date()


def within_call_window(
    moment: datetime | None = None,
    *,
    start: time = DEFAULT_CALL_WINDOW_START,
    end: time = DEFAULT_CALL_WINDOW_END,
) -> bool:
    """Is this moment inside the permitted collections calling window (IST)?"""
    local = to_ist(moment or utc_now()).time()
    return start <= local <= end


def next_call_window_open(
    moment: datetime | None = None,
    *,
    start: time = DEFAULT_CALL_WINDOW_START,
    end: time = DEFAULT_CALL_WINDOW_END,
) -> datetime:
    """The next instant at which calling becomes permitted, in UTC."""
    local = to_ist(moment or utc_now())
    if local.time() < start:
        opens = local.replace(hour=start.hour, minute=start.minute, second=0, microsecond=0)
    elif local.time() > end:
        opens = (local + timedelta(days=1)).replace(
            hour=start.hour, minute=start.minute, second=0, microsecond=0
        )
    else:
        opens = local
    return opens.astimezone(UTC)


def format_ddmmyyyy(value: date | datetime) -> str:
    """Indian document convention: DD/MM/YYYY."""
    if isinstance(value, datetime):
        value = to_ist(value).date()
    return value.strftime("%d/%m/%Y")


def parse_ddmmyyyy(text: str) -> date:
    """Parse DD/MM/YYYY or DD-MM-YYYY. Raises ValueError on anything else."""
    cleaned = text.strip().replace("-", "/").replace(".", "/")
    return datetime.strptime(cleaned, "%d/%m/%Y").date()
