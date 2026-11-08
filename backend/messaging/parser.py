"""
Parse stock commands sent by SMS or WhatsApp. Pure Python, no Django, so it is easy to test.

Grammar (case-insensitive; items separated by commas, semicolons or new lines):

  REMOVE <LOC>: <item> <qty>[, <item> <qty> …] [#reason]   ask for goods to be removed
  REMOVED <LOC>: …                                          goods were already removed (→ needs approval)
  ADD <LOC>: …   /   ADDED <LOC>: …                         same for adding stock
  TRANSFER <FROM> > <TO>: <item> <qty>, …                   request a transfer
  STOCK [<LOC>] <item>                                      ask for a stock balance
  CONFIRM <ref> / DONE <ref>                                manager: goods moved as asked
  APPROVE <ref>                                             admin: apply the change
  REJECT <ref> [reason]                                     admin: refuse
  HELP

<item> is a SKU (PNT-4L-WHT) or a product code followed by size/colour words (PNT 4L WHITE).
<qty> is the last number on the item: "CEM 10", "CEM x10", "CEM 10pcs", "CEM - 10", "10 CEM" also works.
"""
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation

VERBS = {
    "REMOVE": ("remove", False), "OUT": ("remove", False), "TOA": ("remove", False),
    "REMOVED": ("remove", True), "TAKEN": ("remove", True),
    "ADD": ("add", False), "IN": ("add", False), "ONGEZA": ("add", False),
    "ADDED": ("add", True),
    "TRANSFER": ("transfer", False), "MOVE": ("transfer", False), "HAMISHA": ("transfer", False),
    "STOCK": ("stock", False), "BAL": ("stock", False), "BALANCE": ("stock", False),
    "CONFIRM": ("confirm", False), "DONE": ("confirm", False), "SAWA": ("confirm", False),
    "APPROVE": ("approve", False), "OK": ("approve", False),
    "REJECT": ("reject", False), "DECLINE": ("reject", False),
    "HELP": ("help", False), "MENU": ("help", False),
}
REASON_WORDS = {
    "damaged": "damaged", "broken": "damaged", "expired": "expired", "lost": "lost", "stolen": "lost",
    "return": "return_supplier", "supplier": "return_supplier", "site": "internal_use", "internal": "internal_use",
    "customer": "customer_pickup", "pickup": "customer_pickup", "delivery": "customer_pickup",
    "found": "found", "correction": "correction", "count": "correction",
}
QTY_RE = re.compile(r"^(?:x|qty|q)?(\d+(?:\.\d+)?)(?:x|pcs|pc|bags?|kg|m|l|ltrs?|rolls?|boxes|box|pkts?|tins?|sheets?)?$", re.I)
REF_RE = re.compile(r"\b([A-Z]{2,3})-?0*(\d{1,6})\b", re.I)


@dataclass
class Item:
    tokens: list          # product code / sku first, then size & colour words
    quantity: Decimal
    raw: str


@dataclass
class Command:
    action: str = ""
    already_done: bool = False
    location: str = ""
    destination: str = ""
    items: list = field(default_factory=list)
    reason: str = "other"
    reason_text: str = ""
    reference: str = ""
    query_tokens: list = field(default_factory=list)
    errors: list = field(default_factory=list)

    @property
    def ok(self):
        return not self.errors


def _clean(text):
    text = (text or "").replace("\u2019", "'").replace("×", "x").strip()
    return re.sub(r"[ \t]+", " ", text)


def _split_reason(body):
    m = re.search(r"(?:#|\breason\s*[:=]\s*|\bbecause\b)(.+)$", body, re.I | re.S)
    if not m:
        return body, "other", ""
    text = m.group(1).strip()
    reason = "other"
    for word, code in REASON_WORDS.items():
        if word in text.lower():
            reason = code
            break
    return body[: m.start()].strip(), reason, text[:200]


def _parse_item(chunk):
    chunk = chunk.strip(" -:.")
    if not chunk:
        return None, None
    tokens = [t for t in re.split(r"[\s=]+", chunk.replace(" - ", " ")) if t and t not in {"-", "of", "OF"}]
    qty = None
    # quantity at the end ("CEM 10") or at the start ("10 CEM")
    for idx in (len(tokens) - 1, 0):
        if 0 <= idx < len(tokens):
            m = QTY_RE.match(tokens[idx])
            if m:
                try:
                    qty = Decimal(m.group(1))
                except InvalidOperation:
                    continue
                tokens.pop(idx)
                break
    if qty is None:
        return None, f"'{chunk}': add a quantity, e.g. '{chunk} 10'"
    if qty <= 0:
        return None, f"'{chunk}': quantity must be more than zero"
    if not tokens:
        return None, f"'{chunk}': which product?"
    return Item(tokens=[t.upper() for t in tokens], quantity=qty, raw=chunk), None


def parse(text: str) -> Command:
    cmd = Command()
    text = _clean(text)
    if not text:
        cmd.errors.append("Empty message. Send HELP for the command list.")
        return cmd
    first, _, rest = text.partition(" ")
    verb = first.strip(":").upper()
    if verb not in VERBS:
        cmd.errors.append(f"I don't know '{first}'. Start with REMOVE, ADD, TRANSFER, STOCK, CONFIRM or APPROVE. Send HELP.")
        return cmd
    cmd.action, cmd.already_done = VERBS[verb]
    rest = rest.strip()

    if cmd.action == "help":
        return cmd

    if cmd.action in ("confirm", "approve", "reject"):
        m = REF_RE.search(rest)
        if not m:
            cmd.errors.append(f"Add the reference, e.g. {verb} SR00012")
            return cmd
        cmd.reference = f"{m.group(1).upper()}{int(m.group(2)):05d}"
        cmd.reason_text = rest[m.end():].strip(" :-")[:200]
        return cmd

    if cmd.action == "stock":
        parts = rest.replace(":", " ").split()
        if not parts:
            cmd.errors.append("Which product? e.g. STOCK GDN CEM")
            return cmd
        if len(parts) >= 2:
            cmd.location = parts[0].upper()  # may be a location; the handler checks and falls back
        cmd.query_tokens = [p.upper() for p in parts]
        return cmd

    # REMOVE / ADD / TRANSFER: "<LOC>[ > <LOC2>]: items"
    if ":" in rest:
        head, body = rest.split(":", 1)
    else:
        head, _, body = rest.partition(" ")
        if cmd.action == "transfer" and ">" not in head:
            m = re.match(r"^(\S+)\s*(?:>|to)\s*(\S+)\s+(.*)$", rest, re.I | re.S)
            if m:
                head, body = f"{m.group(1)}>{m.group(2)}", m.group(3)
    head = head.strip()
    if cmd.action == "transfer":
        m = re.match(r"^(\S+)\s*(?:>|to|-)\s*(\S+)$", head, re.I)
        if not m:
            cmd.errors.append("Write the transfer like: TRANSFER GDN>SHP1: CEM 10")
            return cmd
        cmd.location, cmd.destination = m.group(1).upper(), m.group(2).upper()
    else:
        cmd.location = head.split()[0].upper() if head else ""
    if not cmd.location:
        cmd.errors.append(f"Which store? e.g. {verb} GDN: CEM 10")
        return cmd

    body, cmd.reason, cmd.reason_text = _split_reason(body)
    for chunk in re.split(r"[,;\n]+|\band\b", body, flags=re.I):
        if not chunk.strip():
            continue
        item, error = _parse_item(chunk)
        if error:
            cmd.errors.append(error)
        elif item:
            cmd.items.append(item)
    if not cmd.items and not cmd.errors:
        cmd.errors.append(f"List the products, e.g. {verb} {cmd.location}: CEM 10, PNT 4L WHITE 2")
    return cmd


HELP_TEXT = (
    "StockFlow commands:\n"
    "REMOVE GDN: CEM 10, PNT 4L WHITE 2 #damaged\n"
    "REMOVED SHP1: NAIL3 5 (already done)\n"
    "ADD GDN: CEM 20\n"
    "TRANSFER GDN>SHP1: CEM 10\n"
    "STOCK GDN CEM\n"
    "CONFIRM SR00012 | APPROVE SR00012 | REJECT SR00012 reason"
)
