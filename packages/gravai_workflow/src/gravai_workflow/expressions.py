"""Templates and conditions over the workflow state.

Two jobs, both deliberately small:

* `render` turns `{{workflow.facts}}` inside a prompt into the value it names.
* `evaluate` decides whether `facts.bureau_score > 700 and documents_verified`
  is true.

Neither uses `eval`. A router condition is a piece of a lending decision and it
arrives from a form field, so it is parsed by a grammar that can only compare
and combine — there is no expression here that can call anything, import
anything, or reach outside the state it was handed.

The parser is a plain recursive descent over a small grammar:

    expr       := or_expr
    or_expr    := and_expr ( 'or' and_expr )*
    and_expr   := not_expr ( 'and' not_expr )*
    not_expr   := 'not' not_expr | comparison
    comparison := primary ( op primary )?
    primary    := '(' expr ')' | literal | path
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

TEMPLATE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


class ExpressionError(ValueError):
    """The expression could not be parsed or could not be evaluated."""


# --- paths ------------------------------------------------------------------


def lookup(path: str, scope: dict[str, Any]) -> Any:
    """Resolve a dotted path, or raise saying how far it got.

    Naming the last segment that worked is the difference between "fix this
    typo" and "something, somewhere, is missing".
    """
    current: Any = scope
    walked: list[str] = []

    for raw in path.split("."):
        segment = raw.strip()
        if not segment:
            raise ExpressionError(f"{path!r} has an empty segment")

        index: int | None = None
        match = re.fullmatch(r"([^\[\]]+)\[(\d+)\]", segment)
        if match:
            segment, index = match.group(1), int(match.group(2))

        if isinstance(current, dict) and segment in current:
            current = current[segment]
        else:
            where = ".".join(walked) or "the workflow state"
            available = (
                ", ".join(sorted(str(k) for k in current)[:8])
                if isinstance(current, dict)
                else "nothing addressable"
            )
            raise ExpressionError(
                f"{path!r}: {segment!r} is not in {where} (available: {available})"
            )
        walked.append(segment)

        if index is not None:
            if not isinstance(current, (list, tuple)):
                raise ExpressionError(f"{path!r}: {'.'.join(walked)} is not a list")
            if index >= len(current):
                raise ExpressionError(
                    f"{path!r}: index {index} is past the end of "
                    f"{'.'.join(walked)} ({len(current)} items)"
                )
            current = current[index]
            walked[-1] = f"{walked[-1]}[{index}]"

    return current


# --- templating -------------------------------------------------------------


def render(text: str, scope: dict[str, Any], *, strict: bool = True) -> str:
    """Substitute every `{{ path }}` in a string.

    Objects and lists are rendered as indented JSON, because the usual
    destination is a prompt and a Python `repr` full of single quotes reads
    badly to a model and to a person.
    """

    def replace(match: re.Match[str]) -> str:
        path = match.group(1)
        try:
            value = lookup(path, scope)
        except ExpressionError:
            if strict:
                raise
            return match.group(0)
        if isinstance(value, str):
            return value
        if isinstance(value, (dict, list)):
            return json.dumps(value, indent=2, ensure_ascii=False, default=str)
        return json.dumps(value, default=str)

    return TEMPLATE.sub(replace, text)


def referenced_paths(text: str) -> list[str]:
    """Every path a template mentions, for validating before a run."""
    return [match.group(1).strip() for match in TEMPLATE.finditer(text)]


# --- conditions -------------------------------------------------------------

_TOKEN = re.compile(
    r"""
    \s*(?:
        (?P<op>==|!=|>=|<=|>|<)
      | (?P<lparen>\()
      | (?P<rparen>\))
      | (?P<string>"[^"]*"|'[^']*')
      | (?P<number>-?\d+(?:\.\d+)?)
      | (?P<word>[A-Za-z_][A-Za-z0-9_.\[\]]*)
    )
    """,
    re.VERBOSE,
)

_KEYWORDS = {"and", "or", "not", "in", "contains", "true", "false", "null", "none", "empty"}


@dataclass(frozen=True, slots=True)
class Token:
    kind: str
    text: str


def _tokenise(source: str) -> list[Token]:
    tokens: list[Token] = []
    position = 0
    while position < len(source):
        match = _TOKEN.match(source, position)
        if not match:
            if source[position:].strip():
                raise ExpressionError(f"Cannot read {source[position:].strip()[:20]!r}")
            break
        position = match.end()
        kind = match.lastgroup or ""
        text = match.group(kind)
        if kind == "word" and text.lower() in _KEYWORDS:
            tokens.append(Token(text.lower(), text.lower()))
        else:
            tokens.append(Token(kind, text))
    return tokens


class _Parser:
    def __init__(self, tokens: list[Token], scope: dict[str, Any]) -> None:
        self.tokens = tokens
        self.scope = scope
        self.position = 0

    def peek(self) -> Token | None:
        return self.tokens[self.position] if self.position < len(self.tokens) else None

    def take(self) -> Token:
        token = self.peek()
        if token is None:
            raise ExpressionError("The expression ends unexpectedly")
        self.position += 1
        return token

    def expect(self, kind: str) -> Token:
        token = self.take()
        if token.kind != kind:
            raise ExpressionError(f"Expected {kind} but found {token.text!r}")
        return token

    # grammar ------------------------------------------------------------

    def parse(self) -> Any:
        value = self.or_expr()
        if self.peek() is not None:
            raise ExpressionError(f"Unexpected {self.peek().text!r} at the end")  # type: ignore[union-attr]
        return value

    def or_expr(self) -> Any:
        value = self.and_expr()
        while (token := self.peek()) and token.kind == "or":
            self.take()
            right = self.and_expr()
            value = truthy(value) or truthy(right)
        return value

    def and_expr(self) -> Any:
        value = self.not_expr()
        while (token := self.peek()) and token.kind == "and":
            self.take()
            right = self.not_expr()
            value = truthy(value) and truthy(right)
        return value

    def not_expr(self) -> Any:
        token = self.peek()
        if token and token.kind == "not":
            self.take()
            return not truthy(self.not_expr())
        return self.comparison()

    def comparison(self) -> Any:
        left = self.primary()
        token = self.peek()
        if token is None:
            return left

        if token.kind == "op":
            self.take()
            return _compare(token.text, left, self.primary())
        if token.kind == "in":
            self.take()
            return _contains(self.primary(), left)
        if token.kind == "contains":
            self.take()
            return _contains(left, self.primary())
        if token.kind == "empty":
            # `warnings empty` reads better than `len(warnings) == 0` in a form.
            self.take()
            return not truthy(left)
        return left

    def primary(self) -> Any:
        token = self.take()
        if token.kind == "lparen":
            value = self.or_expr()
            self.expect("rparen")
            return value
        if token.kind == "string":
            return token.text[1:-1]
        if token.kind == "number":
            return Decimal(token.text)
        if token.kind == "true":
            return True
        if token.kind == "false":
            return False
        if token.kind in {"null", "none"}:
            return None
        if token.kind == "not":
            return not truthy(self.not_expr())
        if token.kind == "word":
            return lookup(token.text, self.scope)
        raise ExpressionError(f"Unexpected {token.text!r}")


def truthy(value: Any) -> bool:
    """Emptiness is false; everything present is true."""
    if value is None or value is False:
        return False
    if isinstance(value, (str, list, tuple, dict, set)):
        return len(value) > 0
    if isinstance(value, (int, float, Decimal)):
        return value != 0
    return True


def _number(value: Any) -> Decimal | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str):
        try:
            return Decimal(value.strip())
        except (InvalidOperation, ValueError):
            return None
    return None


def _compare(operator: str, left: Any, right: Any) -> bool:
    """Compare numerically where both sides are numbers, textually otherwise.

    A bureau score arriving as the string "712" from a JSON source must still
    be greater than 700, or a router silently takes the wrong branch.
    """
    left_number, right_number = _number(left), _number(right)
    if left_number is not None and right_number is not None:
        left, right = left_number, right_number
    elif operator in {">", ">=", "<", "<="}:
        raise ExpressionError(f"Cannot order {left!r} against {right!r}: they are not both numbers")
    else:
        left = left if isinstance(left, (str, bool, type(None))) else str(left)
        right = right if isinstance(right, (str, bool, type(None))) else str(right)

    if operator == "==":
        return bool(left == right)
    if operator == "!=":
        return bool(left != right)
    if operator == ">":
        return bool(left > right)  # type: ignore[operator]
    if operator == ">=":
        return bool(left >= right)  # type: ignore[operator]
    if operator == "<":
        return bool(left < right)  # type: ignore[operator]
    if operator == "<=":
        return bool(left <= right)  # type: ignore[operator]
    raise ExpressionError(f"Unknown operator {operator!r}")


def _contains(haystack: Any, needle: Any) -> bool:
    if haystack is None:
        return False
    if isinstance(haystack, str):
        return str(needle) in haystack
    if isinstance(haystack, dict):
        return needle in haystack
    if isinstance(haystack, (list, tuple, set)):
        if needle in haystack:
            return True
        return any(str(item) == str(needle) for item in haystack)
    return False


def evaluate(expression: str, scope: dict[str, Any]) -> bool:
    """Evaluate a condition to true or false, or raise saying why not."""
    if not expression or not expression.strip():
        raise ExpressionError("The condition is empty")
    tokens = _tokenise(expression)
    if not tokens:
        raise ExpressionError("The condition is empty")
    return truthy(_Parser(tokens, scope).parse())


def check(expression: str) -> None:
    """Parse without a scope, to catch syntax errors before a run.

    Paths are resolved against an empty scope, so a missing name is not an
    error here — only a malformed expression is.
    """
    tokens = _tokenise(expression)
    if not tokens:
        raise ExpressionError("The condition is empty")
    parser = _Parser(tokens, {})
    try:
        parser.parse()
    except ExpressionError as exc:
        if "is not in" in str(exc):
            return
        raise
