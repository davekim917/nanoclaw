export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/support-illysium.json
python3 <<'PY'
import json, subprocess, sys, re

# NO local state. New-vs-existing-ticket is decided HOST-side from the central
# support_threads table when the agent calls dispatch_support_issue — the
# poller never tracks which threads are ticketed. The Gmail `bot-ticketed`
# label (applied after dispatch) is the only "already processed" marker, and
# it lives in Gmail itself.

def gws(*args):
    r = subprocess.run(["gws", *args], capture_output=True, text=True, timeout=60)
    if r.returncode != 0: return None
    try: return json.loads(r.stdout)
    except: return None

# Gmail query: exclude already-ticketed, promotions/updates/social/forums categories,
# and obvious automated noreply senders. Real support emails come from people, not
# notification systems.
query = (
    "in:inbox -label:bot-ticketed "
    "-category:promotions -category:updates -category:social -category:forums "
    "-from:noreply -from:no-reply -from:donotreply -from:do-not-reply "
    "-from:notifications@ -from:notification@ -from:mailer-daemon "
    "-from:workspace-noreply@google.com -from:calendar-notification@google.com "
    "-from:postmaster@ -from:bounces@"
)

listing = gws("gmail","users","messages","list","--params",
              json.dumps({"userId":"me","q":query,"maxResults":50}))
msgs = (listing or {}).get("messages", [])
if not msgs:
    print(json.dumps({"wakeAgent": False}))
    sys.exit(0)

# Senders that look automated even if they slip past the query filters above.
AUTOMATED_FROM_RE = re.compile(
    r"(noreply|no-reply|donotreply|do-not-reply|notifications?@|mailer-daemon|"
    r"postmaster@|bounces?@|@.*\.mailgun\.|@sendgrid\.|@mailchimp|@hubspot|"
    r"workspace-noreply|google\.com>?$.*workspace|calendar-notification)",
    re.IGNORECASE,
)

summaries = []
for m in msgs[:25]:
    full = gws("gmail","users","messages","get","--params",
               json.dumps({"userId":"me","id":m["id"],"format":"metadata",
                           "metadataHeaders":["From","Subject","Date","Message-ID","List-Unsubscribe","Precedence","Auto-Submitted"]}))
    if not full: continue
    headers = {h["name"]: h["value"] for h in full.get("payload",{}).get("headers",[])}
    sender = headers.get("From","")
    label_ids = set(full.get("labelIds", []))

    # Skip if Gmail classified it as bulk/promotional/automated.
    if label_ids & {"CATEGORY_PROMOTIONS","CATEGORY_UPDATES","CATEGORY_SOCIAL","CATEGORY_FORUMS"}:
        continue
    # Skip mailing-list / bulk / auto-submitted mail.
    if headers.get("List-Unsubscribe") or headers.get("Precedence","").lower() in ("bulk","list","junk"):
        continue
    if headers.get("Auto-Submitted","").lower() not in ("", "no"):
        continue
    if AUTOMATED_FROM_RE.search(sender):
        continue

    summaries.append({
        "id": m["id"],
        "threadId": m["threadId"],
        "from": sender,
        "subject": headers.get("Subject",""),
        "date": headers.get("Date",""),
        "messageIdHeader": headers.get("Message-ID",""),
        "snippet": (full.get("snippet","") or "")[:400],
    })

if not summaries:
    print(json.dumps({"wakeAgent": False}))
    sys.exit(0)

print(json.dumps({"wakeAgent": True, "data": {"newMessages": summaries}}))
PY