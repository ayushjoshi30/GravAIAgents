"""Name matching for Indian identity documents.

Indian names defeat naive string comparison routinely, and each way they do it
is a real case seen on real files:

* order varies — "Narayanan Lakshmi" against "Lakshmi Narayanan"
* initials expand or contract — "L. Narayanan" against "Lakshmi Narayanan"
* patronymics and surnames appear in one document and not another
* transliteration differs — "Lakshmi" / "Laxmi", "Krishna" / "Krishnaa"
* honorifics and relational prefixes — "Shri", "Smt", "S/o", "W/o"

So the comparison is token-based with phonetic fallback, not a string distance.
It returns a score with the reasoning attached, because a KYC mismatch is a
decision a human has to be able to review.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

#: Stripped before comparison. Not name content.
HONORIFICS = frozenset(
    {
        "mr",
        "mrs",
        "ms",
        "miss",
        "dr",
        "prof",
        "shri",
        "sri",
        "smt",
        "kum",
        "md",
        "mohd",
        "late",
        "m/s",
        "messrs",
    }
)

#: Relational prefixes that introduce a *different* person's name.
RELATIONAL = re.compile(r"\b([SDWCsdwc])\s*[/.]\s*[OoAa]\b.*$")

_PUNCT = re.compile(r"[^\w\s]")
_SPACES = re.compile(r"\s+")


def normalise(name: str) -> str:
    """Strip accents, punctuation, honorifics and relational suffixes."""
    if not name:
        return ""
    text = unicodedata.normalize("NFKD", name)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = RELATIONAL.sub("", text)
    text = _PUNCT.sub(" ", text).lower()
    tokens = [t for t in _SPACES.split(text) if t and t not in HONORIFICS]
    return " ".join(tokens)


def _phonetic(token: str) -> str:
    """A deliberately loose phonetic key for Indian transliterations.

    Collapses the substitutions that actually vary between documents — ks/x,
    doubled letters, aspirated consonants, and trailing vowels — rather than
    implementing Soundex, which was designed for English surnames and merges
    Indian names badly.
    """
    if not token:
        return ""
    key = token.lower()
    for old, new in (
        ("ksh", "x"),
        ("ks", "x"),
        ("sh", "s"),
        ("ch", "c"),
        ("ph", "f"),
        ("th", "t"),
        ("dh", "d"),
        ("bh", "b"),
        ("gh", "g"),
        ("kh", "k"),
        ("jh", "j"),
        ("zh", "j"),
        ("z", "j"),
        ("v", "w"),
        ("ee", "i"),
        ("oo", "u"),
        ("aa", "a"),
    ):
        key = key.replace(old, new)
    # Collapse runs of the same letter: "krishnaa" and "krishna" are one name.
    collapsed: list[str] = []
    for char in key:
        if not collapsed or collapsed[-1] != char:
            collapsed.append(char)
    key = "".join(collapsed)
    # Trailing vowels vary freely in transliteration.
    return key.rstrip("aeiou") or key


@dataclass(frozen=True, slots=True)
class NameMatch:
    """A score with its reasoning, so a reviewer can judge it."""

    score: float
    method: str
    matched: list[str] = field(default_factory=list)
    unmatched_left: list[str] = field(default_factory=list)
    unmatched_right: list[str] = field(default_factory=list)

    @property
    def explanation(self) -> str:
        if self.score >= 0.99:
            return "The names match exactly once honorifics and ordering are set aside."
        parts = [f"Matched {len(self.matched)} name part(s) by {self.method}."]
        if self.unmatched_left or self.unmatched_right:
            missing = ", ".join(self.unmatched_left + self.unmatched_right)
            parts.append(f"Unmatched: {missing}.")
        return " ".join(parts)


def _token_matches(left: str, right: str) -> tuple[bool, str]:
    """Do two name tokens refer to the same name part?"""
    if left == right:
        return True, "exact"
    # An initial matches any token starting with the same letter.
    if len(left) == 1 and right.startswith(left):
        return True, "initial"
    if len(right) == 1 and left.startswith(right):
        return True, "initial"
    if _phonetic(left) == _phonetic(right):
        return True, "phonetic"
    return False, ""


def match_names(left: str, right: str) -> NameMatch:
    """Compare two names, order-insensitively.

    Scores the share of the *shorter* name's tokens that are accounted for, so a
    document carrying an extra surname does not penalise the match — a very
    common difference between Aadhaar and PAN records.
    """
    left_tokens = normalise(left).split()
    right_tokens = normalise(right).split()

    if not left_tokens or not right_tokens:
        return NameMatch(score=0.0, method="none")

    if left_tokens == right_tokens:
        return NameMatch(score=1.0, method="exact", matched=left_tokens)

    remaining = list(right_tokens)
    matched: list[str] = []
    methods: set[str] = set()
    unmatched_left: list[str] = []

    for token in left_tokens:
        for index, candidate in enumerate(remaining):
            ok, how = _token_matches(token, candidate)
            if ok:
                matched.append(token)
                methods.add(how)
                remaining.pop(index)
                break
        else:
            unmatched_left.append(token)

    denominator = min(len(left_tokens), len(right_tokens))
    score = len(matched) / denominator if denominator else 0.0

    # A match resting only on initials is weaker evidence than a full one.
    if methods == {"initial"} and score >= 1.0:
        score = 0.85

    return NameMatch(
        score=round(min(score, 1.0), 3),
        method="+".join(sorted(methods)) or "none",
        matched=matched,
        unmatched_left=unmatched_left,
        unmatched_right=remaining,
    )
