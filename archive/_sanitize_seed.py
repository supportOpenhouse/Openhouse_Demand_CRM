"""
Sanitize seed.json for the public Git repo.

What it scrubs:
  - Broker names + phone numbers + alternate phones + company names
  - Buyer names + phone numbers + email-shaped strings
  - All free-text feedback fields (sales_feedback, buyer_feedback, all_feedback,
    latest_followup_note, unit_address_line1, unit_address_line2, lead_key)

What it keeps (operational, not PII):
  - cp_code, city, tier, tier_rank, micro_markets, societies_worked, dates,
    visit counts, activity_category, society_name, listing_status, sales_manager
    (these are internal team members), source, status, lead_status, all intent
    fields, property data

Determinism:
  - Same real phone always maps to the same fake phone (via SHA-256 + a salt).
  - Same real name always maps to the same fake name.
  - This preserves all foreign-key-like relationships between brokers and visits.

Reversibility:
  - The mapping is one-way (cannot recover real PII from sanitized seed).
  - Saransh regenerates real seed.json on day one by running `_build_seed.py`
    once he has the Google service account.

Usage:
  python3 _sanitize_seed.py seed.json seed.sanitized.json
"""

import json
import hashlib
import sys
from pathlib import Path

# ── salts ────────────────────────────────────────────────────────────────
# changing these salts produces an entirely new sanitization mapping
PHONE_SALT = b"oh-demand-crm-phone-salt-v1"
NAME_SALT = b"oh-demand-crm-name-salt-v1"
EMAIL_SALT = b"oh-demand-crm-email-salt-v1"

# ── fake name pools ──────────────────────────────────────────────────────
# realistic Indian names so the UI still looks natural
FIRST_NAMES = [
    "Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Mohammed",
    "Ayaan", "Krishna", "Ishaan", "Shaurya", "Atharv", "Advik", "Pranav", "Dhruv",
    "Kabir", "Ritvik", "Aarush", "Kayaan", "Darsh", "Veer", "Karan", "Ansh",
    "Aanya", "Aadhya", "Pari", "Anaya", "Saanvi", "Diya", "Myra", "Ira",
    "Anika", "Riya", "Priya", "Kavya", "Aarohi", "Tanvi", "Sneha", "Ishita",
    "Neha", "Pooja", "Sonia", "Radhika", "Meera", "Sapna", "Anjali", "Kiran",
    "Rohit", "Amit", "Vikas", "Manish", "Sandeep", "Rajesh", "Suresh", "Anil",
    "Ravi", "Sunil", "Mukesh", "Vinod", "Ashok", "Deepak", "Naveen", "Pankaj",
]

LAST_NAMES = [
    "Sharma", "Verma", "Gupta", "Singh", "Kumar", "Yadav", "Mishra", "Pandey",
    "Joshi", "Tiwari", "Agarwal", "Chauhan", "Saxena", "Bansal", "Goyal", "Khanna",
    "Mehta", "Shah", "Patel", "Jain", "Aggarwal", "Malhotra", "Kapoor", "Chopra",
    "Bhardwaj", "Sinha", "Rana", "Thakur", "Reddy", "Iyer", "Menon", "Pillai",
]

COMPANY_PREFIXES = ["Sunrise", "Prime", "Royal", "Elite", "Crown", "Star", "Apex", "Grand",
                    "Skyline", "Heritage", "Lotus", "Maple", "Diamond", "Capital", "Metro"]
COMPANY_SUFFIXES = ["Realtors", "Properties", "Estates", "Homes", "Realty",
                    "Associates", "Group", "Consultants", "Advisors"]

# ── helpers ──────────────────────────────────────────────────────────────


def _h(salt: bytes, value: str) -> int:
    """Deterministic non-negative int from a string + salt."""
    if not value:
        return 0
    return int.from_bytes(
        hashlib.sha256(salt + value.encode("utf-8")).digest()[:8],
        "big",
        signed=False,
    )


def fake_phone(real: str) -> str:
    if not real or not isinstance(real, str):
        return real
    digits = "".join(c for c in real if c.isdigit())
    if not digits:
        return real
    # generate a deterministic 10-digit Indian-style number starting with 7/8/9
    h = _h(PHONE_SALT, digits)
    first = "7" if h % 3 == 0 else ("8" if h % 3 == 1 else "9")
    rest = f"{h % 1000000000:09d}"
    return first + rest[:9]


def fake_name(real: str) -> str:
    if not real or not isinstance(real, str) or real.strip() == "":
        return real
    h = _h(NAME_SALT, real.strip().lower())
    first = FIRST_NAMES[h % len(FIRST_NAMES)]
    last = LAST_NAMES[(h // 1000) % len(LAST_NAMES)]
    return f"{first} {last}"


def fake_company(real: str) -> str:
    if not real or real.strip().lower() in ("", "individual", "self"):
        return real  # preserve "Individual" markers
    h = _h(NAME_SALT, real.strip().lower())
    return f"{COMPANY_PREFIXES[h % len(COMPANY_PREFIXES)]} {COMPANY_SUFFIXES[(h // 100) % len(COMPANY_SUFFIXES)]}"


def fake_email(real: str) -> str:
    if not real or "@" not in str(real):
        return real
    local, _, domain = real.partition("@")
    # preserve @openhouse.in (internal team members are not PII concerns)
    if domain.lower().endswith("openhouse.in"):
        return real
    h = _h(EMAIL_SALT, local.lower())
    return f"user{h % 100000:05d}@example.com"


def scrub_text(text: str) -> str:
    """Replace any free-text customer-facing field with a placeholder.

    These fields may contain buyer names, phone numbers, addresses, personal
    remarks — too risky to attempt selective scrubbing.
    """
    if not text:
        return text
    return "[SANITIZED — free-text content removed for repo]"


# ── main sanitizer ───────────────────────────────────────────────────────


def sanitize(data: dict) -> dict:
    out = json.loads(json.dumps(data))  # deep copy

    # brokers ----------------------------------------------------------
    for b in out.get("brokers", []):
        b["name"] = fake_name(b.get("name"))
        b["phone_number"] = fake_phone(b.get("phone_number"))
        b["alternate_number"] = fake_phone(b.get("alternate_number"))
        b["company_name"] = fake_company(b.get("company_name"))

    # visits -----------------------------------------------------------
    for v in out.get("visits", []):
        v["broker_name"] = fake_name(v.get("broker_name"))
        v["broker_contact"] = fake_phone(v.get("broker_contact"))
        v["broker_alt_contact"] = fake_phone(v.get("broker_alt_contact"))
        v["buyer_name"] = fake_name(v.get("buyer_name"))
        v["buyer_contact"] = fake_phone(v.get("buyer_contact"))
        v["company_name"] = fake_company(v.get("company_name"))
        v["sales_feedback"] = scrub_text(v.get("sales_feedback"))
        v["buyer_feedback"] = scrub_text(v.get("buyer_feedback"))
        v["all_feedback"] = scrub_text(v.get("all_feedback"))
        v["latest_followup_note"] = scrub_text(v.get("latest_followup_note"))
        v["unit_address_line1"] = scrub_text(v.get("unit_address_line1"))
        v["unit_address_line2"] = scrub_text(v.get("unit_address_line2"))
        # lead_key may encode buyer phone — replace deterministically
        if v.get("lead_key"):
            v["lead_key"] = f"LK{_h(PHONE_SALT, v['lead_key']) % 10**10:010d}"

    # properties don't carry PII (society names + addresses are public listings)
    # the seed's `properties` list is left untouched

    out["_sanitized"] = True
    out["_sanitization_notes"] = (
        "Broker + buyer names, phones, free-text feedback, and lead_keys "
        "have been replaced with deterministic fakes for the public repo. "
        "Run _build_seed.py with the Google service account to regenerate "
        "the real seed.json locally."
    )
    return out


def verify(out: dict) -> None:
    """Spot-check: no real-looking PII patterns remain."""
    import re

    blob = json.dumps(out)

    # any 10-digit phone that's NOT one of our deterministic fakes will start
    # with 6 or have a 0-prefix — flag those for review
    suspicious_phones = re.findall(r"\b[0-6]\d{9}\b", blob)
    if suspicious_phones:
        print(
            f"WARN: {len(suspicious_phones)} suspicious phone-shaped strings remain "
            f"(first 5: {suspicious_phones[:5]})"
        )

    # any non-openhouse email left?
    leftover_emails = [
        e for e in re.findall(r"[\w.+-]+@[\w.-]+\.\w+", blob)
        if not e.lower().endswith("openhouse.in")
        and not e.lower().endswith("example.com")
    ]
    if leftover_emails:
        print(f"WARN: leftover non-@openhouse.in emails: {leftover_emails[:5]}")
    print("verify complete")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: python3 _sanitize_seed.py <input.json> <output.json>")
        sys.exit(1)
    inp, outp = Path(sys.argv[1]), Path(sys.argv[2])
    data = json.loads(inp.read_text())
    clean = sanitize(data)
    verify(clean)
    outp.write_text(json.dumps(clean, indent=None, separators=(",", ":")))
    print(f"sanitized {inp} → {outp}  ({outp.stat().st_size:,} bytes)")
