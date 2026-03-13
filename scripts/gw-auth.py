#!/usr/bin/env python3
"""One-time OAuth flow to generate workspace-mcp credential files."""
import json, os, sys
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/presentations.readonly",
]

client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET")
if not client_id or not client_secret:
    print("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first")
    sys.exit(1)

flow = InstalledAppFlow.from_client_config(
    {"installed": {
        "client_id": client_id,
        "client_secret": client_secret,
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
    }},
    SCOPES,
)

creds = flow.run_local_server(port=8000, access_type="offline", prompt="consent", open_browser=False)

# Get the authenticated email
from googleapiclient.discovery import build
service = build("oauth2", "v2", credentials=creds)
email = service.userinfo().get().execute()["email"]

# Save in workspace-mcp format
creds_dir = os.path.expanduser("~/.google_workspace_mcp/credentials")
os.makedirs(creds_dir, exist_ok=True)
path = os.path.join(creds_dir, f"{email}.json")
with open(path, "w") as f:
    json.dump({
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes),
        "expiry": creds.expiry.isoformat() if creds.expiry else None,
    }, f, indent=2)

print(f"Saved: {path}")
print(f"Run again to authorize the next account.")
