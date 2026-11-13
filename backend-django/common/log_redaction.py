"""
Keeps secrets out of the logs (Node: config/logger.js `redact`). A filter on the log handlers
replaces bearer tokens, JWTs and `password=`/`"otp": ...`-style values in the message and in
tracebacks with [REDACTED].
"""

import logging
import re

REDACTED = "[REDACTED]"
_KEYS = (
    r"password|passwd|token|refresh_?token|access_?token|otp|secret|authorization|account_?number"
)
_PAIR = re.compile(rf"""(?i)(["']?(?:{_KEYS})["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}}]+)""")
_JWT = re.compile(r"eyJ[\w-]+\.[\w-]+\.[\w-]+")
_BEARER = re.compile(r"(?i)(bearer\s+)[\w.~+/=-]+")


def scrub(text: str) -> str:
    text = _JWT.sub(REDACTED, text)
    text = _BEARER.sub(rf"\1{REDACTED}", text)
    return _PAIR.sub(rf"\1{REDACTED}", text)


class RedactSecrets(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        clean = scrub(message)
        if clean != message:
            record.msg, record.args = clean, ()
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = scrub(record.exc_text)
        return True
